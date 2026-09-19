// Putting text on the clipboard, on the device she actually uses.
//
// Safari on iPad is the constraint here, and it is a real one:
//
// 1. The write has to happen in the turn of the tap that asked for it. Safari
//    ties clipboard access to a user gesture, and an `await` before the write
//    spends it — so the caller builds the string first and calls this with it
//    already in hand. Nothing in this file awaits before writing.
// 2. `navigator.clipboard` is not always there. It needs a secure context, and
//    older iPadOS does not have writeText at all. So there is a second path
//    through `document.execCommand('copy')`, which is deprecated everywhere and
//    still the only thing that works on those devices.
// 3. iOS refuses to select a plain hidden textarea. The selection has to be
//    made with a Range over a contentEditable element that is in the layout —
//    off-screen, not `display:none` — and `setSelectionRange` after it. That
//    combination is the whole reason the fallback looks the way it does.

/** The off-screen element the fallback copies out of. */
function stage(text) {
  const node = document.createElement('textarea');
  node.value = text;
  node.setAttribute('readonly', '');
  // In the layout but out of sight, and never focusable by tab. `position:
  // fixed` with a tiny size keeps iOS from scrolling the page to it.
  node.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:none;' +
    'outline:none;box-shadow:none;background:transparent;opacity:0;';
  return node;
}

/**
 * Copy text the old way. Returns whether it worked.
 *
 * Kept as a named export so a test can drive it directly: on a browser that
 * has `navigator.clipboard` this path is otherwise unreachable, and an
 * untested fallback is no fallback.
 */
export function copyViaSelection(text) {
  const node = stage(text);
  document.body.appendChild(node);

  const selection = document.getSelection();
  const saved = selection && selection.rangeCount ? selection.getRangeAt(0) : null;

  let ok = false;
  try {
    // contentEditable, then a Range, then setSelectionRange: iOS needs all
    // three. Editable is toggled off again before the element goes, so nothing
    // in the page is left editable if this throws.
    node.contentEditable = 'true';
    node.readOnly = false;
    const range = document.createRange();
    range.selectNodeContents(node);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (node.setSelectionRange) node.setSelectionRange(0, text.length);
    ok = Boolean(document.execCommand && document.execCommand('copy'));
  } catch {
    ok = false;
  } finally {
    node.contentEditable = 'false';
    if (selection) {
      selection.removeAllRanges();
      // Whatever the person had selected before is put back. Silently eating a
      // selection is the kind of small rudeness that is easy to ship.
      if (saved) selection.addRange(saved);
    }
    node.remove();
  }
  return ok;
}

/**
 * Put text on the clipboard.
 *
 * Call this synchronously from the tap. The modern path is tried first and the
 * selection path catches both "this browser has no clipboard API" and "it has
 * one and it refused" — a refusal is common enough on iPadOS that falling
 * through to the old way is worth more than reporting the failure.
 *
 * @returns {Promise<boolean>} whether the text is on the clipboard
 */
export function copyText(text) {
  const value = String(text == null ? '' : text);
  if (!value) return Promise.resolve(false);

  const api = typeof navigator !== 'undefined' && navigator.clipboard;
  if (api && typeof api.writeText === 'function') {
    let attempt;
    try {
      attempt = api.writeText(value);
    } catch {
      return Promise.resolve(copyViaSelection(value));
    }
    return Promise.resolve(attempt)
      .then(() => true)
      // The gesture is spent by the time this runs, so the fallback may be
      // refused too — but on the devices where writeText rejects outright it
      // is usually execCommand that was going to work anyway.
      .catch(() => copyViaSelection(value));
  }

  return Promise.resolve(copyViaSelection(value));
}
