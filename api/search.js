// KHÔNG CẦN CLOUDFLARE, GỌI API TRỰC TIẾP TỐC ĐỘ CAO
const TPB_API_PROXIES = [
    "https://apibay.org",
    "https://thepiratebay.org",
    "https://piratebayproxy.net"
];

// Mã khóa tự chế để đồng bộ bảo mật với server Beamup của bạn
const MY_SECRET_KEY = "sudungchinhxacmanay";

export default async function handler(req, res) {
    // 🌟 THÊM ĐOẠN NÀY: Nếu trình duyệt đòi file favicon.ico, trả về trạng thái rỗng lập tức
    // Việc này giúp dứt điểm hoàn toàn lỗi Content-Security-Policy màu đỏ trên console
    if (req.url.includes("favicon.ico")) {
        res.setHeader("Content-Type", "image/x-icon");
        return res.status(204).end(); // Mã 204: No Content (Phản hồi thành công không chứa dữ liệu)
    }
    // Kích hoạt CORS mở rộng
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    const { query, category, key } = req.query;

    // Xác thực mã bảo mật bí mật
    if (key !== MY_SECRET_KEY) {
        return res.status(401).json({ error: "Unauthorized access key." });
    }

    // Chuyển đổi mã danh mục Stremio sang danh mục số chuẩn của PirateBay (200: Video, 500: Adult)
    let tpbCategory = category === "5070" ? "500" : "200";
    let apiData = null;

    // Vòng lặp quét nhanh qua các máy chủ API dự phòng công cộng
    for (const baseApiUrl of TPB_API_PROXIES) {
        try {
            // Định dạng Endpoint API chuẩn của hệ thống PirateBay (Bỏ qua cào HTML)
            const targetApiUrl = `${baseApiUrl}/q.php?q=${encodeURIComponent(query)}&cat=${tpbCategory}`;
            console.log(`[VERCEL API CONNECT] Đang kết nối cổng dữ liệu: ${targetApiUrl}`);

            // Gọi hàm fetch nội bộ của Node.js (Vercel hỗ trợ sẵn không cần cài thêm thư viện)
            const response = await fetch(targetApiUrl, { signal: AbortSignal.timeout(4000) });
            const json = await response.json();
            
            // Nếu API trả về mảng chứa dữ liệu phim hợp lệ, bốc và thoát vòng lặp ngay
            if (Array.isArray(json) && json.length > 0 && json[0].id !== "0") {
                apiData = json;
                break;
            }
        } catch (err) {
            console.warn(`[API WARNING] Cổng ${baseApiUrl} nghẽn mạch (${err.message}). Thử nguồn dự phòng...`);
            continue;
        }
    }

    // Nếu tất cả các cổng API đều không phản hồi dữ liệu, xuất mảng rỗng an toàn
    if (!apiData) {
        return res.status(200).json([]);
    }

    try {
        // ÁNH XẠ ĐÓNG GÓI DỮ LIỆU (Đồng bộ 100% cấu trúc cũ của Addon bạn)
        const formattedTorrents = apiData.map(item => {
            if (!item.info_hash || item.info_hash === "0000000000000000000000000000000000000000") return null;

            const title = item.name || "Unknown Movie";
            const cleanHash = String(item.info_hash).toLowerCase().trim();
            const seeders = parseInt(item.seeders) || 0;
            const leechers = parseInt(item.leechers) || 0;
            
            // Đổi kích thước byte thô sang định dạng dung lượng GB sạch sẽ
            const sizeInGB = item.size ? (parseInt(item.size) / 1024 / 1024 / 1024).toFixed(2) : "0.00";
            const indexer = item.username || "PirateBay-Vercel-API";
            const imdbId = item.imdb && item.imdb !== "0" ? item.imdb : "none";

            // Tự động bóc độ phân giải phân tầng
            let resolution = "SD";
            const titleUpper = title.toUpperCase();
            if (titleUpper.includes("4K") || titleUpper.includes("2160P")) resolution = "4K";
            else if (titleUpper.includes("1080P") || titleUpper.includes("FHD")) resolution = "1080p";
            else if (titleUpper.includes("720P") || titleUpper.includes("HD")) resolution = "720p";

            // ĐÓNG GÓI CHUỖI KÝ TỰ ĐẶC BIỆT ĐỒNG BỘ LUỒNG RÃ GÓI TRÊN ADDON.JS CỦA BẠN
            const packedData = `${title}||${sizeInGB}||${seeders}||${leechers}||${indexer}||${resolution}||${imdbId}`;

            return {
                name: packedData,
                infoHash: cleanHash,
                magnet: `magnet:?xt=urn:btih:${cleanHash}&dn=${encodeURIComponent(title)}`,
                resolution: resolution,
                seeders: seeders
            };
        }).filter(t => t !== null);

        // Xuất dải dữ liệu JSON hoàn hảo
        return res.status(200).json(formattedTorrents);

    } catch (parseErr) {
        return res.status(200).json([]);
    }
};
