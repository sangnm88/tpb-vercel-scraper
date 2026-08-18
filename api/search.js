const http = require('http');
const url = require('url');
const fs = require('fs'); // Thêm thư viện đọc file hệ thống
const path = require('path'); // Thêm thư viện xử lý đường dẫn file
const axios = require('axios');
const { createAgent, checkProxyStatus, scrapePirateBayMirrors, checkProxyAnonymity } = require('../utils/proxy');
const { getActiveProxy, getTargetUrls, maskProxyString, scrapeSingleUrl, fillTargetUrl} = require('../utils/util');

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
        let { target: singleTarget, proxy: userProxy, query: searchQuery, category, page, ...dynamicParams } = params;

        //const axiosParams = { q: searchQuery || '', cat: category || '', ...dynamicParams };

        // Chuẩn hóa tham số lõi của bạn
        const baseAxiosParams = { 
            q: searchQuery || '', 
            cat: category || '0', 
            page: page || '0',
            ...dynamicParams 
        };

        // 1. Phân tích danh sách Target URL (Đọc từ list.txt nếu singleTarget trống)
        let targetUrls;
        try {
            targetUrls = getTargetUrls(singleTarget);
        } catch (err) {
            return res.status(400).json({ success: false, error: err.message });
        }

        console.log(`🚀 Bắt đầu duyệt tuần tự danh sách gồm ${targetUrls.length} URL...`);

        // 2. Vòng lặp duyệt tuần tự danh sách Target URL - Có kết quả thành công thì ngừng ngay
        for (let i = 0; i < targetUrls.length; i++) {
            const currentTarget = targetUrls[i];
            
			// THỰC HIỆN ĐIỀN THAM SỐ: Chuyển đổi định dạng link khảm sang link thật tại đây
            const { finalUrl, finalParams } = fillTargetUrl(currentTarget, baseAxiosParams);

            // Bốc ngẫu nhiên proxy cho lượt cào này
            const { proxy: selectedProxy, source: proxySource } = getActiveProxy(userProxy);

            try {
                console.log(`[Dòng ${i + 1}/${targetUrls.length}] Đang cào URL: ${currentTarget}`);
                
                // Gọi hàm cào đơn lẻ từ Util.js (Truyền thêm các hàm phụ thuộc của bạn: createAgent, checkProxyStatus)
                const { message, data } = await scrapeSingleUrl(finalUrl, selectedProxy, finalParams, createAgent, checkProxyStatus);
                

                // Mã hóa bảo mật thông tin proxy trước khi trả về client
                const clientProxyInfo = maskProxyString(selectedProxy);

                console.log(`✅ Thành công tại dòng ${i + 1}. Trả dữ liệu an toàn về client.`);
                return res.status(200).json({
                    success: true,
                    matched_line: singleTarget ? 'direct' : i + 1,
                    url: currentTarget,
                    proxy_used: clientProxyInfo,
                    proxy_source: proxySource,
                    data: data,
                    message: message
                });

            } catch (error) {
                console.warn(`❌ Lỗi tại dòng ${i + 1} (${currentTarget}): ${error.message}. Thử dòng kế tiếp...`);
            }
        }

        // 3. Trường hợp duyệt hết sạch danh sách mà tất cả đều lỗi
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
    res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// Trả về file style.css độc lập
app.get('/style.css', (req, res) => {
    //res.sendFile(path.join(__dirname, 'style.css'));
    // process.cwd() sẽ lấy thư mục gốc của dự án (môi trường Docker là /app, Vercel là thư mục gốc cloud)
    res.sendFile(path.join(process.cwd(), 'public', 'style.css'));
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
