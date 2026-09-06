/** Focus and reveal within the active scroll container, preserving the page behind a dialog. */
export function revealInDialog(node:HTMLElement|null) {
  if(!node)return;
  node.focus({preventScroll:true});
  let container=node.parentElement;
  while(container && !container.classList.contains('modal-backdrop')) {
    if(/auto|scroll/.test(getComputedStyle(container).overflowY) && container.scrollHeight>container.clientHeight) {
      const header=container.classList.contains('modal') ? container.querySelector('.modal__header')?.getBoundingClientRect().height ?? 0 : 0;
      container.scrollTop+=node.getBoundingClientRect().top-container.getBoundingClientRect().top-header-16;
      break;
    }
    container=container.parentElement;
  }
}
