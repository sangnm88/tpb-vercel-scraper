const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent'); // Nạp thêm thư viện SOCKS

/**
 * Hàm khởi tạo Agent động dựa trên Giao thức (HTTP hay SOCKS)
 */
function createAgent(proxyUrl) {
    // Nếu là proxy dạng SOCKS (socks://, socks4://, socks5://)
    if (proxyUrl.startsWith('socks')) {
        return new SocksProxyAgent(proxyUrl);
    }
    // Ngược lại mặc định sử dụng HTTP/HTTPS Agent
    return new HttpsProxyAgent(proxyUrl);
}

/**
 * Hàm kiểm tra xem một Proxy bất kỳ (HTTP hoặc SOCKS) còn sống hay không
 */
async function checkProxyStatus(proxyUrl) {
    if (!proxyUrl) return { success: false, message: 'Chuỗi Proxy trống' };

    try {
        const agent = createAgent(proxyUrl);

        // Gửi request thử nghiệm đến server kiểm tra IP công cộng
        const response = await axios.get('https://ipinfo.io', {
            httpsAgent: agent,
            httpAgent: agent, // Bổ sung thêm httpAgent cho các proxy SOCKS chạy mượt hơn
            proxy: false,
            timeout: 5000 // Quá 5 giây không phản hồi coi như proxy chết
        });

        const { ip, country, region } = response.data;
        return {
            success: true,
            message: `Proxy kết nối ổn định!`,
            details: { ip, country, region, formattedUrl: proxyUrl }
        };
    } catch (error) {
        return {
            success: false,
            message: `Proxy không phản hồi (Lỗi kết nối hoặc Proxy đã chết).`,
            details: { error: error.message }
        };
    }
}

/**
 * Hàm cào danh sách link mirror của The Pirate Bay từ GitHub README
 * @returns {Promise<Array<string>>} Mảng chứa danh sách các URL mirror
 */
async function scrapePirateBayMirrors() {
    try {
        console.log('🌐 [Scraper] Đang cào danh sách link từ GitHub...');
        // Sử dụng link raw của file README.md hoặc trang render HTML từ GitHub để bóc tách
        const response = await axios.get('https://githubusercontent.com', {
            timeout: 5000
        });

        const markdownText = response.data;
        // Sử dụng Regex để trích xuất tất cả các đường dẫn URL bắt đầu bằng http:// hoặc https://
        const urlRegex = /https?:\/\/[^\s\)\`\|]+/g;
        const matches = markdownText.match(urlRegex) || [];

        // Lọc bỏ các link trùng nhau và loại trừ các link hệ thống của GitHub
        const mirrors = [...new Set(matches)].filter(link => 
            link.includes('proxy') || 
            link.includes('bay') || 
            link.includes('pirate')
        ).filter(link => !link.includes('github.com'));

        return mirrors;
    } catch (error) {
        console.error('❌ [Scraper] Lỗi khi cào dữ liệu từ GitHub:', error.message);
        // Trả về danh sách dự phòng cứng nếu GitHub gặp sự cố mạng
        return [
            'https://tpbpirateproxy.org',
            'https://pirateproxy.space',
            'https://thepiratebay10.org',
            'https://pirateproxy.net'
        ];
    }
}

/**
 * BỔ SUNG: Hàm kiểm tra mức độ ẩn danh của Proxy
 */
async function checkProxyAnonymity(proxyUrl) {
    if (!proxyUrl) return { success: false, error: 'Chuỗi Proxy trống' };

    try {
        const agent = createAgent(proxyUrl);
        
        // 1. Lấy IP thật của máy bạn trước để đối chiếu
        let myRealIp = '';
        try {
            const realIpRes = await axios.get('https://seeip.org', { timeout: 6000 });
            myRealIp = realIpRes.data.ip;

            //Show thông  tin Ip thật của máy
            console.log(`Địa chỉ IP thật của máy đang sử dụng: ${myRealIp}`)
        } catch (e) {
            // Nếu lỗi lấy IP thật, bỏ qua đối chiếu IP thô
            console.log(`Có lỗi khi lấy IP: ${e.message}`)
        }

        // 2. Gửi request qua Proxy tới httpbin để lấy Header phản hồi
        const response = await axios.get('https://httpcan.org/get', {
            httpsAgent: agent,
            httpAgent: agent,
            proxy: false,
            timeout: 6000
        });

        const headers = response.data.headers || {};
        const originStr = response.data.origin || '';

        // Chuyển tất cả key header về chữ thường để kiểm tra chính xác
        const lowerHeaders = {};
        Object.keys(headers).forEach(key => {
            lowerHeaders[key.toLowerCase()] = headers[key].toLowerCase();
        });

        let level = 'Elite (High Anonymity)'; // Mặc định nếu không phát hiện vết rò rỉ
        let details = 'Không phát hiện bất kỳ dấu vết rò rỉ IP thật nào. Tuyệt đối an toàn.';

        // Dấu hiệu nhận biết Proxy Transparent hoặc Anonymous
        const proxySignatures = ['via', 'forwarded', 'x-forwarded-for', 'x-proxy-user-ip', 'client-ip', 'proxy-connection'];
        const hasProxySignature = proxySignatures.some(sig => lowerHeaders[sig] !== undefined);

        if (hasProxySignature) {
            // Kiểm tra xem có bị rò rỉ IP thật trong chuỗi Headers hoặc Origin không
            const leakedIp = originStr.includes(myRealIp) || 
                             proxySignatures.some(sig => lowerHeaders[sig] && lowerHeaders[sig].includes(myRealIp));

            if (leakedIp && myRealIp) {
                level = 'Transparent (Lộ hoàn toàn)';
                details = 'Proxy này để lộ toàn bộ địa chỉ IP thật của bạn và báo cho server đích biết bạn đang xài Proxy.';
            } else {
                level = 'Anonymous (Ẩn danh vừa)';
                details = 'Server đích biết bạn đang sử dụng Proxy, nhưng địa chỉ IP gốc của bạn vẫn được giữ bí mật.';
            }
        }

        return {
            success: true,
            level: level,
            description: details,
            proxy_ip: originStr.split(',')[0].trim(),
            headers_sent: headers
        };

    } catch (error) {
        return {
            success: false,
            error: 'Không thể phân tích độ ẩn danh do Proxy không phản hồi.',
            details: error.message
        };
    }
}

module.exports = {
    createAgent,
    checkProxyStatus,
    scrapePirateBayMirrors,
    checkProxyAnonymity
};
