const http = require('http');
const url = require('url');
const fs = require('fs'); // Thêm thư viện đọc file hệ thống
const path = require('path'); // Thêm thư viện xử lý đường dẫn file
const axios = require('axios');
const { createAgent, checkProxyStatus, scrapePirateBayMirrors, checkProxyAnonymity } = require('../utils/proxy');
const USE_PROXY = false;

const express = require('express');

// Khởi tạo ứng dụng Express
const app = express();

// Middleware cấu hình tự động parse JSON body và Form data (nếu sau này cần)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

async function handler(req, res, next) {
    try {
        const params = { ...req.query, ...req.body };
        let { target: singleTarget, proxy: userProxy, query: searchQuery, category, ...dynamicParams } = params;

        const axiosParams = { q: searchQuery || '', cat: category || '', ...dynamicParams };

        // -----------------------------------------------------------------
        // [HÀM TRỢ GIÚP 1: LẤY PROXY LINH ĐỘNG (RANDOM NẾU DÙNG FILE)]
        function getActiveProxy() {
            // Nếu người dùng truyền proxy trực tiếp qua API, ưu tiên dùng luôn
            if (userProxy) {
                return { proxy: userProxy, source: 'direct_param' };
            }

            // Nếu không truyền, tìm kiếm ngẫu nhiên trong file proxy.txt
            const proxyFilePath = path.join(process.cwd(), 'proxy.txt');
            if (fs.existsSync(proxyFilePath)) {
                try {
                    const fileContent = fs.readFileSync(proxyFilePath, 'utf8');
                    const proxyList = fileContent.split('\n')
                                                 .map(p => p.trim())
                                                 .filter(p => p.length > 0 && !p.startsWith('#'));

                    if (proxyList.length > 0) {
                        const randomIndex = Math.floor(Math.random() * proxyList.length);
                        return { proxy: proxyList[randomIndex], source: 'proxy_txt_file' };
                    }
                } catch (fileErr) {
                    console.error('⚠️ Lỗi đọc file proxy.txt:', fileErr.message);
                }
            }

            // Mặc định không dùng proxy nếu cả 2 điều kiện trên không thỏa mãn
            return { proxy: null, source: 'none' };
        }

        // -----------------------------------------------------------------
        // [HÀM TRỢ GIÚP 2: CÀO MỘT URL ĐƠN LẺ VỚI PROXY ĐƯỢC CHỈ ĐỊNH]
        async function scrapeSingleUrl(url, targetProxy) {
            const browserHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
                'Referer': 'https://google.com'
            };

            if (targetProxy) {
                // Kiểm tra trạng thái proxy trước khi cào dữ liệu
                const checkResult = await checkProxyStatus(targetProxy);
                if (!checkResult.success) {
                    throw new Error(`Proxy [${targetProxy}] đã chết.`);
                }

                const customAgent = createAgent(targetProxy);
                const response = await axios.get(url, {
                    httpsAgent: customAgent,
                    httpAgent: customAgent,
                    proxy: false,
                    timeout: 7000,
                    params: axiosParams,
                    headers: browserHeaders
                });
                return response.data;
            } else {
                const response = await axios.get(url, { 
                    timeout: 7000, 
                    params: axiosParams,
                    headers: browserHeaders
                });
                return response.data;
            }
        }

        // -----------------------------------------------------------------
        // [XỬ LÝ DANH SÁCH TARGET URL]
        let targetUrls = [];

        if (singleTarget) {
            // Nếu người dùng truyền đích danh target qua API
            targetUrls.push(singleTarget);
        } else {
            // Nếu không truyền target, đọc toàn bộ danh sách từ file list.txt
            const listFilePath = path.join(process.cwd(), 'list.txt');
            if (!fs.existsSync(listFilePath)) {
                return res.status(400).json({ success: false, error: 'URL đích trống và không tìm thấy tệp tin list.txt.' });
            }

            const fileContent = fs.readFileSync(listFilePath, 'utf8');
            targetUrls = fileContent.split('\n')
                                    .map(url => url.trim())
                                    .filter(url => url.length > 0 && !url.startsWith('#'));

            if (targetUrls.length === 0) {
                return res.status(400).json({ success: false, error: 'Tệp tin list.txt không chứa URL hợp lệ nào.' });
            }
        }

        // -----------------------------------------------------------------
        // [VÒNG LẶP DUYỆT TUẦN TỰ TỪNG DÒNG TARGET URL - THÀNH CÔNG THÌ NGỪNG]
        console.log(`🚀 Bắt đầu duyệt tuần tự danh sách gồm ${targetUrls.length} URL...`);

        // -----------------------------------------------------------------
        // [XỬ LÝ LUỒNG CHẠY CHÍNH VÀ TRẢ KẾT QUẢ ĐÃ BẢO MẬT]
        console.log(`🚀 Bắt đầu duyệt tuần tự danh sách gồm ${targetUrls.length} URL...`);

        for (let i = 0; i < targetUrls.length; i++) {
            const currentTarget = targetUrls[i];
            const { proxy: selectedProxy, source: proxySource } = getActiveProxy();

            try {
                // Log nội bộ trên máy chủ (Chỉ hiển thị trong Vercel Log / Docker Log, client không thấy)
                console.log(`[Dòng ${i + 1}] Đang cào: ${currentTarget} | Proxy: ${selectedProxy || 'Mạng trực tiếp'}`);
                
                const data = await scrapeSingleUrl(currentTarget, selectedProxy);
                
                // --- XỬ LÝ MÃ HÓA / ẨN THÔNG TIN PROXY TRƯỚC KHI TRẢ VỀ CLIENT ---
                let proxyInfoForClient = 'none_direct_connection';
                
                if (selectedProxy) {
                    // Nếu đang chạy ở Local/Docker Development, cho phép xem toàn bộ để debug
                    if (process.env.NODE_ENV === 'development' || process.env.DOCKER_ENV === 'true') {
                        proxyInfoForClient = selectedProxy;
                    } else {
                        // Nếu chạy trên Vercel Production: Chỉ trả về định dạng ẩn danh (Ví dụ: http://***:***@1.2.3.4:8080)
                        try {
                            const urlObj = new URL(selectedProxy);
                            // Che giấu phần username và password nếu có
                            if (urlObj.username || urlObj.password) {
                                proxyInfoForClient = `${urlObj.protocol}//***:***@${urlObj.host}`;
                            } else {
                                // Nếu proxy không có pass, chỉ ẩn một phần IP/Port để nhận diện
                                proxyInfoForClient = `${urlObj.protocol}//${urlObj.host.replace(/[^.:]/g, '*')}`;
                            }
                        } catch (e) {
                            proxyInfoForClient = 'protected_masked_proxy';
                        }
                    }
                }

                // Trả kết quả an toàn về cho người dùng
                console.log(`✅ Thành công tại dòng ${i + 1}. Trả dữ liệu an toàn về client.`);
                return res.status(200).json({
                    success: true,
                    matched_line: singleTarget ? 'direct' : i + 1,
                    url: currentTarget,
                    proxy_used: proxyInfoForClient, // <--- THÔNG TIN ĐÃ ĐƯỢC BẢO VỆ
                    proxy_source: proxySource,
                    data: data
                });

            } catch (error) {
                console.warn(`❌ Lỗi tại dòng ${i + 1} (${currentTarget}): ${error.message}`);
            }
        }

        // TRƯỜNG HỢP TOÀN BỘ DANH SÁCH TARGET ĐỀU BỊ LỖI
        return res.status(502).json({
            success: false,
            error: "Đã duyệt hết tất cả các dòng URL trong list.txt nhưng không trang nào cào thành công."
        });


    } catch (globalError) {
        next(globalError);
    }
}


// BỎ QUA VÀ XỬ LÝ NHANH REQUEST FAVICON CỦA TRÌNH DUYỆT
app.get('/favicon.ico', (req, res) => {
    res.status(204).end(); 
});

// Trả về file index.html khi vào trang chủ
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Trả về file style.css độc lập
app.get('/style.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'style.css'));
});

// API Check Anonymity
app.get('/api/check-anonymity', async (req, res) => {
    try {
        const userProxy = req.query?.proxy || '';
        const anonResult = await checkProxyAnonymity(userProxy);
        
        if (anonResult.success) {
            res.status(200).json({ success: true, data: anonResult });
        } else {
            res.status(500).json({ success: false, error: anonResult.error });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API Get Mirrors
app.get('/api/get-mirrors', async (req, res) => {
    try {
        const mirrorLinks = await scrapePirateBayMirrors();
        res.status(200).json({ success: true, data: mirrorLinks });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API Check Proxy Status
app.get('/api/check-proxy', async (req, res) => {
    try {
        const userProxy = req.query?.proxy || '';
        const checkResult = await checkProxyStatus(userProxy);
        
        if (checkResult.success) {
            res.status(200).json({ success: true, message: checkResult.message, proxy_info: checkResult.details });
        } else {
            res.status(500).json({ success: false, error: checkResult.message, details: checkResult.details?.error });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Thay đổi route thành POST để nhận Body dữ liệu
app.all('/api/search', async (req, res, next) => {
    await handler(req, res, next);
});


// Middleware xử lý Lỗi 404 Not Found cho các route không tồn tại
app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
});

// KHỞI CHẠY EXPRESS SERVER LOCAL / DOCKER
if (require.main === module || process.env.DOCKER_ENV === 'true') {
    const PORT = process.env.PORT || 5050;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Hệ thống chạy tối ưu modular mở tại: http://localhost:${PORT}`);
    });
}

// Export app để Vercel có thể nhận diện và chạy dưới dạng Serverless Function khi deploy
module.exports = app;
