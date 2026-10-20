// Applies the saved theme before first paint to avoid a light/dark flash.
(function () {
  try {
    var theme = JSON.parse(localStorage.getItem('drivepro.theme') || '"system"');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch (e) {}
})();
