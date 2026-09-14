(function () {
  var preference = 'system';
  try {
    var saved = localStorage.getItem('zentra.appearance.v1');
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch (_) { /* Follow the system even if persistent storage is unavailable. */ }
  var dark = preference === 'dark' || preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches;
  var root = document.documentElement;
  root.dataset.appTheme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
  root.style.backgroundColor = dark ? '#141416' : '#f5f5f7';
})();
