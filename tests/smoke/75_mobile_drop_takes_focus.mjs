// Mobile Drop and the keyboard (accessibility session C13-02): the dialog used to open with the focus left in the note (or on the
// header button that opened it), so whatever was typed next landed behind the QR code and changed the note. It now takes the focus
// like the other dialogs, and hands it back to the note when it closes.
import { assert, noteText, waitFocus, waitHidden, waitShown } from './lib.mjs';

export default {
  title: 'Mobile Drop: opening it moves the focus into the dialog, so typing does not change the note',
  session: { notes: [{ title: 'a.md', content: 'alpha' }] },

  async run(s, t) {
    t.step('open it with the shortcut while the note has the focus');
    await s.ev(`(function () { var e = document.getElementById('editor'); e.focus(); e.setSelectionRange(5, 5); })()`);
    await s.key('u', { ctrl: true, shift: true });
    await waitShown(s, 'mobile-drop-modal');
    await waitFocus(s, 'btn-mobile-drop-cancel');

    t.step('typing goes nowhere near the note');
    await s.type('zzz');
    assert.equal(await noteText(s), 'alpha', 'the note did not change');

    t.step('Esc closes it and the note has the focus back');
    await s.key('Escape');
    await waitHidden(s, 'mobile-drop-modal');
    await waitFocus(s, 'editor');
    await s.type('!');
    assert.equal(await noteText(s), 'alpha!', 'typing goes into the note again');
  },
};
