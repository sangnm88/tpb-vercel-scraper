const cloudscraper = require("cloudscraper");
const cheerio = require("cheerio");
// Cap nhat them https://apibay.org
const TPB_PROXIES = [
    "https://apibay.org",
    "https://tpb.party",
    "https://thepiratebay10.org",
    "https://piratebayproxy.net",
    "https://thepiratebay.zone"
];

// Mã khóa tự chế để chỉ duy nhất Server Beamup của bạn có quyền gọi sang lấy dữ liệu
const MY_SECRET_KEY = "sudungchinhxacmanay";

module.exports = async (req, res) => {
    // Bật CORS cho phép kết nối liên mạng
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET");

    const { query, category, key } = req.query;

    if (key !== MY_SECRET_KEY) {
        return res.status(401).json({ error: "Unauthorized access key." });
    }

    let tpbCategory = category === "5070" ? "500" : "200";
    let htmlData = null;

    // Vòng lặp xoay vòng proxy đục Cloudflare
    for (const baseUrl of TPB_PROXIES) {
        try {
            const targetUrl = `${baseUrl}/search/${encodeURIComponent(query)}/1/99/${tpbCategory}`;
            htmlData = await cloudscraper.get(targetUrl);
            
            if (htmlData && !htmlData.includes("Cloudflare")) {
                break;
            }
        } catch (err) {
            continue;
        }
    }

    if (!htmlData) return res.status(200).json([]);

    try {
        const $ = cheerio.load(htmlData);
        const torrents = [];

        $("table#searchResult tr").each((index, element) => {
            if (index === 0) return;

            const titleRow = $(element).find("a.detLink");
            const title = titleRow.text().trim();
            if (!title) return;

            const magnetUrl = $(element).find("a[href^='magnet:']").attr("href");
            const descText = $(element).find("font.detDesc").text();
            const seeders = parseInt($(element).find("td:nth-last-child(2)").text()) || 0;
            const leechers = parseInt($(element).find("td:last-child").text()) || 0;

            const sizeMatch = descText.match(/Size\s+(\d+\.\d+|\d+)\s*(GiB|MiB|GB|MB)/i);
            let sizeInGB = "0.00";
            if (sizeMatch) {
                const sizeVal = parseFloat(sizeMatch[1]);
                const sizeUnit = sizeMatch[2].toUpperCase();
                sizeInGB = sizeUnit.includes("G") ? sizeVal.toFixed(2) : (sizeVal / 1024).toFixed(2);
            }

            let infoHash = null;
            if (magnetUrl) {
                const hashMatch = magnetUrl.match(/btih:([a-fA-F0-9]{40})/i);
                infoHash = hashMatch ? hashMatch[1].toLowerCase() : null;
            }

            let resolution = "SD";
            const titleUpper = title.toUpperCase();
            if (titleUpper.includes("4K") || titleUpper.includes("2160P")) resolution = "4K";
            else if (titleUpper.includes("1080P") || titleUpper.includes("FHD")) resolution = "1080p";
            else if (titleUpper.includes("720P") || titleUpper.includes("HD")) resolution = "720p";

            if (infoHash) {
                // Đóng gói gộp dữ liệu thành chuỗi đóng gói giống hệt hàm cũ của bạn ở Prowlarr
                const packedData = `${title}||${sizeInGB}||${seeders}||${leechers}||PirateBay-Vercel-Cloud||${resolution}`;
                torrents.push({
                    name: packedData,
                    infoHash: infoHash,
                    magnet: magnetUrl || `magnet:?xt=urn:btih:${infoHash}`,
                    resolution: resolution,
                    seeders: seeders
                });
            }
        });

        return res.status(200).json(torrents);

    } catch (parseErr) {
        return res.status(200).json([]);
    }
};

