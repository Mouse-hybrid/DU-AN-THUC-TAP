import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      on('task', {
        des05Note(message) {
          console.log(`[DES-QA-05] ${message}`);
          return null;
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
