export function enhanceEditorControls(root: HTMLElement, readOnly: () => boolean) {
  const update = () => {
    for (const wrapper of root.querySelectorAll<HTMLElement>('.milkdown-list-item-block .label-wrapper')) {
      const checked = wrapper.querySelector('.label.checked') !== null
      const unchecked = wrapper.querySelector('.label.unchecked') !== null
      if (!checked && !unchecked) continue
      wrapper.setAttribute('role', 'checkbox')
      wrapper.setAttribute('aria-checked', String(checked))
      wrapper.setAttribute('aria-disabled', String(readOnly()))
      wrapper.setAttribute('tabindex', readOnly() ? '-1' : '0')
      wrapper.dataset.mdKeyboard = 'pointerdown'
      const text = wrapper.closest('.milkdown-list-item-block')?.querySelector('.content-dom')?.textContent?.trim()
      wrapper.setAttribute('aria-label', text?.slice(0, 120) || 'チェック項目')
    }
    for (const button of root.querySelectorAll<HTMLElement>('.milkdown-block-handle .operation-item:first-child')) {
      button.setAttribute('role', 'button')
      button.setAttribute('aria-label', '下にブロックを追加')
      button.setAttribute('tabindex', readOnly() ? '-1' : '0')
      button.dataset.mdKeyboard = 'pointerup'
    }
    for (const button of root.querySelectorAll<HTMLElement>('.milkdown-block-handle .operation-item:nth-child(2)')) {
      button.setAttribute('title', 'ドラッグして移動。キーボードではブロック操作メニューを使えます。')
    }
  }
  let frame = 0
  const activate = (event: KeyboardEvent) => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-md-keyboard]') : null
    if (!element || readOnly() || event.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    if (element.dataset.mdKeyboard === 'pointerup') {
      element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }))
    } else {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { if (element.isConnected) element.focus() })
    }
  }
  const observer = new MutationObserver(update)
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'contenteditable'] })
  root.addEventListener('keydown', activate, true)
  update()
  return () => {
    observer.disconnect()
    root.removeEventListener('keydown', activate, true)
    cancelAnimationFrame(frame)
  }
}
