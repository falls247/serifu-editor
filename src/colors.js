export const TRANSPARENT = 'transparent';
export const isTextColor = value => typeof value === 'string' && (value === TRANSPARENT || /^#[0-9a-f]{6}$/i.test(value));
export const colorInputValue = input => input.closest('.color-picker')?.classList.contains('is-transparent') ? TRANSPARENT : input.value;

export function syncColorInput(input, value) {
  const transparent = value === TRANSPARENT;
  if (!transparent && isTextColor(value)) input.value = value;
  const picker = input.closest('.color-picker');
  if (!picker) return;
  picker.classList.toggle('is-transparent', transparent);
  picker.querySelector('.transparent-color').setAttribute('aria-pressed', String(transparent));
}

export function enhanceColorInput(input, value, onChange) {
  if (input.closest('.color-picker')) return;
  const label = input.closest('label'), title = label?.textContent.trim() || '色';
  const picker = document.createElement('span');
  picker.className = 'color-picker';
  const transparent = document.createElement('button');
  transparent.type = 'button';
  transparent.className = 'transparent-color';
  transparent.textContent = '透明';
  transparent.title = `${title}を透明にする。再度押すと色を戻す`;
  transparent.setAttribute('aria-label', `${title}：透明`);
  input.replaceWith(picker);
  picker.append(input, transparent);
  input.addEventListener('input', () => syncColorInput(input, input.value));
  transparent.addEventListener('click', event => {
    event.preventDefault();
    const next = transparent.getAttribute('aria-pressed') === 'true' ? input.value : TRANSPARENT;
    onChange(next);
  });
  syncColorInput(input, value);
}
