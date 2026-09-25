describe('Kiểm thử tự động có lưu video và ảnh', () => {
  it('Chạy kịch bản cơ bản', () => {
    // 1. Mở trang web (mất khoảng 1 - 2s)
    cy.visit('https://playwright.dev/');

    // 2. Chụp ảnh chủ động tại bước đầu
    cy.screenshot('01-trang-chu');

    // 3. Thao tác click
    cy.contains('Get started').click();

    // 4. Giữ thời lượng test tối thiểu 3s để video không bị kết thúc quá nhanh
    cy.wait(3000);

    // 5. Kiểm tra phần tử hiển thị
    cy.get('h1').should('be.visible');

    // 6. Chụp ảnh kết quả cuối cùng
    cy.screenshot('02-ket-qua');
  });
});