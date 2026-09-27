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
  var size = 100;
  try {
    var storedSize = Number(localStorage.getItem('zentra.text-size.v1'));
    if ([100, 125, 150, 175, 200].indexOf(storedSize) !== -1) size = storedSize;
  } catch (_) { /* The default size remains readable without storage. */ }
  root.dataset.appTextSize = String(size);
  root.style.setProperty('--zentra-ui-text-scale', String(size / 100));
})();
