const { createAgent, checkProxyStatus, scrapePirateBayMirrors, checkProxyAnonymity } = require('../utils/proxy');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require("cheerio");

/**
 * 1. Lấy thông tin Proxy linh động (Từ param hoặc bốc random từ proxy.txt)
 */
function getActiveProxy(userProxy) {
    if (userProxy) {
        return { proxy: userProxy, source: 'direct_param' };
    }

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
    return { proxy: null, source: 'none' };
}

/**
 * TỰ ĐỘNG ĐIỀN THAM SỐ VÀO TARGET URL NẾU CÓ DẠNG KHẢM BIẾN
 */
function fillTargetUrl(url, axiosParams) {
    if (!url) return { finalUrl: url, finalParams: axiosParams };

    let finalUrl = url;
    let finalParams = { ...axiosParams };

    // Nếu phát hiện URL có chứa cấu trúc khảm biến dạng {variable}
    if (url.includes('{query}')) {
        finalUrl = url
            .replace('{query}', encodeURIComponent(axiosParams.q || '2026'))
            .replace('{page}', encodeURIComponent(axiosParams.page || '1'))
            .replace('{category}', encodeURIComponent(axiosParams.cat || '200'));
        
        // Dọn sạch params để Axios không đính kèm '?q=...&cat=...' vào cuối link nữa
        finalParams = {};
    }

    return { finalUrl, finalParams };
}

/**
 * 2. Đọc toàn bộ danh sách URL đích từ file list.txt
 */
function getTargetUrls(singleTarget) {
    if (singleTarget) {
        return [singleTarget];
    }

    const listFilePath = path.join(process.cwd(), 'list.txt');
    if (!fs.existsSync(listFilePath)) {
        throw new Error('URL đích trống và không tìm thấy tệp tin list.txt.');
    }

    const fileContent = fs.readFileSync(listFilePath, 'utf8');
    const targetUrls = fileContent.split('\n')
                            .map(url => url.trim())
                            .filter(url => url.length > 0 && !url.startsWith('#'));

    if (targetUrls.length === 0) {
        throw new Error('Tệp tin list.txt không chứa URL hợp lệ nào.');
    }

    return targetUrls;
}

/**
 * 3. Che giấu thông tin bảo mật của Proxy khi trả về cho Client (Production Mode)
 */
function maskProxyString(selectedProxy) {
    if (!selectedProxy) return 'none_direct_connection';
    
    // Nếu đang phát triển ở Local/Docker, hiển thị toàn bộ để dễ debug
    if (process.env.NODE_ENV === 'development' || process.env.DOCKER_ENV === 'true') {
        return selectedProxy;
    }

    // Nếu chạy trên Vercel Production, che giấu các thông tin nhạy cảm
    try {
        const urlObj = new URL(selectedProxy);
        if (urlObj.username || urlObj.password) {
            return `${urlObj.protocol}//***:***@${urlObj.host}`;
        }
        return `${urlObj.protocol}//${urlObj.host.replace(/[^.:]/g, '*')}`;
    } catch (e) {
        return 'protected_masked_proxy';
    }
}

/**
 * 4. Thực thi cào một URL đơn lẻ với Proxy động và bộ Headers giả lập trình duyệt
 */
async function scrapeSingleUrl(url, targetProxy, finalParams, createAgent, checkProxyStatus) {
    const browserHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Referer': 'https://google.com'
    };

    const axiosConfig = {
        timeout: 7000,
        headers: browserHeaders,
        params: finalParams
    };
    let message = "Cào dữ liệu thành công";
    if (targetProxy) {
        // Kiểm tra trạng thái proxy
        const checkResult = await checkProxyStatus(targetProxy);
        if (!checkResult.success) {
            //message = `Proxy [${targetProxy}] đã chết.`;
            throw new Error(`Proxy [${targetProxy}] đã chết.`);
        }
        message = checkResult.message;

        const customAgent = createAgent(targetProxy);
        axiosConfig.httpsAgent = customAgent;
        axiosConfig.httpAgent = customAgent;
        axiosConfig.proxy = false;

    } 

    const response = await axios.get(url, axiosConfig);
    let convertData = [];
    if (!response.data || typeof response.data !== "string") 
        convertData = response.data
    else
        convertData = await parseHtmlToTorrents(response.data);

    return {message: message, data: convertData };
}

function parseHtmlToTorrents(htmlData) {
    if (!htmlData || typeof htmlData !== "string") return [];

    try {
        
        const $ = cheerio.load(htmlData);
        const torrents = [];

        // Duyệt qua từng dòng tr trong bảng kết quả tìm kiếm (Bỏ qua dòng tiêu đề index = 0)
        $("table#searchResult tr").each((index, element) => {
            if (index === 0) return;

            // 🌟 SỬA ĐỔI CHÍNH: Lấy tất cả các thẻ con trực tiếp của dòng tr (Bao gồm cả th và td)
            // Việc này giúp bẻ gãy hoàn toàn lỗi đổi cấu trúc thẻ th mới của trang proxy
            const cells = $(element).children().filter(function() {
                return this.tagName === 'td' || this.tagName === 'th';
            });

            // Điều kiện bảo vệ: Một dòng chuẩn bắt buộc phải có đủ từ 7-8 cột trở lên
            if (cells.length < 7) return;

            // 🌟 1. BÓC TIÊU ĐỀ PHIM (CỘT 2 - INDEX 1)
            // Lấy thẻ 'a' đầu tiên nằm trong cột thứ 2 để trích xuất tên phim sạch
            const titleCell = $(cells[1]);
            const titleLink = titleCell.find("a").first();
            const title = titleLink.text().trim();

            // Cứu hộ: Nếu cột 2 bị trống tên, bỏ qua ngay dòng này
            if (!title) return;

            // 🌟 2. BÓC LINK MAGNET (CỘT 4 - INDEX 3)
            // Tìm chính xác thẻ 'a' có thuộc tính href bắt đầu bằng chuỗi "magnet:"
            const magnetCell = $(cells[3]);
            const magnetUrl = magnetCell.find("a[href^='magnet:']").attr("href");

            // Nếu thiếu magnet, tự dựng magnet chuẩn bằng infoHash
            if (!magnetUrl) {
                magnetUrl = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;
            }

            // 🌟 3. BÓC DUNG LƯỢNG SIZE (CỘT 5 - INDEX 4)
            const sizeText = $(cells[4]).text().trim();
            let sizeInGB = "0.00";
            
            // Xử lý chuỗi dung lượng bằng Regex (Ví dụ: "4.5 GiB" hoặc "450 MiB")
            const sizeMatch = sizeText.match(/(\d+\.\d+|\d+)\s*(GiB|MiB|GB|MB)/i);
            if (sizeMatch) {
                const sizeVal = parseFloat(sizeMatch[1]);
                const sizeUnit = sizeMatch[2].toUpperCase();
                sizeInGB = sizeUnit.includes("G") ? sizeVal.toFixed(2) : (sizeVal / 1024).toFixed(2);
            }

            // 🌟 4. BÓC SỐ LƯỢNG SEEDERS (CỘT 6 - INDEX 5) VÀ LEECHERS (CỘT 7 - INDEX 6)
            const seeders = parseInt($(cells[5]).text().trim()) || 0;
            const leechers = parseInt($(cells[6]).text().trim()) || 0;

            // 🌟 5. TRÍCH XUẤT MÃ BẰM INFOHASH VIẾT THƯỜNG TỪ LUỒNG MAGNET LINK
            let infoHash = null;
            const hashMatch = magnetUrl.match(/btih:([a-fA-F0-9]{40})/i);
            infoHash = hashMatch ? hashMatch[1].toLowerCase() : null;

            const indexer = "The Pirate Bay";

            if (!infoHash) return;

            // 🌟 6. TỰ ĐỘNG PHÂN TÁCH ĐỘ PHÂN GIẢI (RESOLUTION) TỪ TIÊU ĐỀ
            let resolution = "1080p"; 
            const titleUpper = title.toUpperCase();
            if (titleUpper.includes("4K") || titleUpper.includes("2160P") || titleUpper.includes("UHD")) {
                resolution = "4K";
            } else if (titleUpper.includes("1080P") || titleUpper.includes("FHD") || titleUpper.includes("BLURAY")) {
                resolution = "1080p";
            } else if (titleUpper.includes("720P") || titleUpper.includes("HD")) {
                resolution = "720p";
            } else if (titleUpper.includes("SD") || titleUpper.includes("CAM") || titleUpper.includes("DVD")) {
                resolution = "SD";
            }

            // LẤY MÃ IMDB ID TỪ PROWLARR: Nếu kết quả trả về dạng số thô 12345, tự chèn thêm chữ "tt" ở đầu
            let rawImdb = "none";
            if (rawImdb !== "none" && !String(rawImdb).startsWith("tt")) {
                rawImdb = `tt${String(rawImdb).padStart(7, '0')}`;
            }

            // 🌟 7 MẤU CHỐT : Đóng gói toàn bộ thông tin gốc thành một chuỗi văn bản (Data Packing)
            // Ngăn cách bằng ký tự đặc biệt "||" để dễ bóc tách bằng lệnh .split() sau này
            const packedData = `${title}||${sizeInGB}||${seeders}||${leechers}||${indexer}||${resolution}||${rawImdb}`;
            const cleanHash = infoHash;

            torrents.push({
                packedData : packedData,// Gửi chuỗi đóng gói vào trường name
                name: title, 
                title: `👤 Seeders: ${seeders} | 👥 Leechers: ${leechers}\n📦 Dung lượng: ${sizeInGB} GB\n🔌 Nguồn: (${indexer || "TPB"})`,
                infoHash: cleanHash,
                magnet: magnetUrl || `magnet:?xt=urn:btih:${cleanHash}`,
                resolution: resolution,
                seeders: seeders // Giữ lại biến số phục vụ thuật toán Sort
            });
        });

        console.log(`[CELL PARSER SUCCESS] Trích xuất thành công ${torrents.length} dòng phim dựa trên thuật toán sơ đồ 8 cột.`);
        return torrents;

    } catch (parseErr) {
        console.error("[PARSE COLUMNS ERROR] Thất bại xử lý mảng ô dữ liệu td:", parseErr.message);
        return [];
    }
}

// Xuất các hàm tiện ích ra để file khác sử dụng
module.exports = {
    getActiveProxy,
    getTargetUrls,
    maskProxyString,
    scrapeSingleUrl,
    fillTargetUrl
};

