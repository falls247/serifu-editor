export function setupAppMenu(menu) {
  const spacer = document.createElement('div');
  spacer.className = 'app-menu-spacer';
  spacer.hidden = true;
  spacer.setAttribute('aria-hidden', 'true');
  menu.before(spacer);
  menu.addEventListener('pointerenter', event => {
    if (event.pointerType === 'touch' || window.scrollY <= 0) return;
    const visible = [...menu.children].filter(node => node.getClientRects().length);
    const height = visible.at(-1).getBoundingClientRect().bottom - visible[0].getBoundingClientRect().top;
    spacer.style.height = height + 'px';
    spacer.hidden = false;
    menu.classList.add('expanded');
    menu.scrollTop = 0;
  });
  menu.addEventListener('pointerleave', () => {
    menu.classList.remove('expanded');
    spacer.hidden = true;
    menu.scrollTop = 0;
  });
  const observer = new ResizeObserver(() => {
    if (!spacer.hidden) spacer.style.height = menu.scrollHeight + 'px';
  });
  for (const node of menu.children) observer.observe(node);
}
