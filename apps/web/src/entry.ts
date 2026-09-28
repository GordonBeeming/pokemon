// Single script tag in index.html so both SPAs share one entry point during the
// /next cutover. The old app owns hashchange/popstate routing on '/', so anything
// under /next must never reach it — the split happens before either app's router runs.
if (location.pathname.startsWith('/next')) {
  void import('./app/main');
} else {
  void import('./react-app/main');
}
