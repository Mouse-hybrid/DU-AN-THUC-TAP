import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      on('task', {
        des05Note(message) {
          console.log(`[DES-QA-05] ${message}`);
          return null;
        },
        async des05ParallelSend({ url, token, keys }) {
          const target = new URL(url);
          if (!/^\/api\/v1\/orders\/[0-9a-f-]{36}\/send-to-kitchen$/i.test(target.pathname) ||
              target.protocol !== 'http:' || !token || !Array.isArray(keys) ||
              keys.length !== 2 || keys[0] === keys[1]) {
            throw new Error('DES05 concurrent Send inputs invalid');
          }
          // Launch both requests before awaiting either response. Return statuses only.
          return Promise.all(keys.map(async (key) => {
            const response = await fetch(url, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
              signal: AbortSignal.timeout(20000),
            });
            return response.status;
          }));
        },
      });
    },
    // Bật ghi video và chụp màn hình
    video: true,
    videosFolder: "cypress/videos",
    screenshotsFolder: "cypress/screenshots",
    screenshotOnRunFailure: true, // Tự động chụp ảnh khi test case thất bại
    trashAssetsBeforeRuns: true,   // Tự dọn sạch video/ảnh cũ trước mỗi lượt chạy
  },
});
