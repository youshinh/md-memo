// Recording the microphone together with the sound this PC plays (Zoom, a video): the Settings switch, its strings, the defaults,
// and the bound backend calls. The behaviour of the recording itself is in frontend/js/voice_input_test.js (page side) and
// app_meeting_test.go / pkg/sysaudio (backend side).
import fs from 'fs';
import assert from 'assert';

console.log('=== Meeting audio wiring tests ===');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const html = read('frontend/index.html');
const app = read('frontend/js/app.js');
const I18N = new Function(read('frontend/js/i18n.js') + '\nreturn I18N;')();
const bind = read('bind_common.go');
const winGo = read('window_windows.go');
const macGo = read('window_darwin.go');

// 1. the switch is in Settings, hidden until the backend says it can do it, and it does not use a "?"-folded consent line
assert.ok(/class="form-group inline-group hidden" id="cfg-voice-system-audio-group"/.test(html), 'the group starts hidden');
assert.ok(/id="cfg-voice-system-audio"/.test(html) && /id="btn-check-meeting-audio"/.test(html) && /id="meeting-audio-check-result"/.test(html));
assert.ok(/<small id="voice-meeting-consent"/.test(html), 'the consent line has an id, so the compact settings view does not fold it away');
assert.ok(/Promise\.resolve\(backend\.meetingRecordingSupported\(\)\)\.then\(\(ok\) => \{ group\.classList\.toggle\('hidden', !ok\); \}\)/.test(app), 'shown only where the backend supports it');

// 2. saved and loaded, default off
assert.ok(/if \(saveSystemAudioEl\) config\.voice\.includeSystemAudio = !!saveSystemAudioEl\.checked;/.test(app), 'saved with the voice settings');
assert.ok(/box\.checked = !!\(config\.voice && config\.voice\.includeSystemAudio\)/.test(app), 'loaded into the switch');
assert.ok(/includeSystemAudio: false/.test(app), 'off by default');

// 3. strings in both languages, none empty, placeholders alike
for (const k of ['voiceSystemAudioLabel', 'voiceSystemAudioConsent', 'voiceSystemAudioHint', 'voiceMeetingCheck', 'voiceMeetingChecking', 'voiceMeetingCheckFailed',
  'voiceMeetingMicOk', 'voiceMeetingMicFail', 'voiceMeetingSysOk', 'voiceMeetingSysFail', 'voiceMeetingTag', 'voiceMeetingFailed', 'voiceMeetingNoMic']) {
  assert.ok(I18N.en[k] && I18N.ja[k], k + ' in both languages');
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  assert.strictEqual(ph(I18N.en[k]), ph(I18N.ja[k]), k + ': same placeholders');
  assert.ok(!/[぀-ヿ一-鿿]/.test(I18N.en[k]), k + ': no Japanese in English');
}
assert.ok(/tell everyone|Tell them first/i.test(I18N.en.voiceSystemAudioHint + I18N.en.voiceSystemAudioConsent), 'the English text asks to tell the participants');
assert.ok(/参加者/.test(I18N.ja.voiceSystemAudioConsent), 'and so does the Japanese');

// 4. the five calls are bound and reach the page on Windows; macOS has the same surface (the backend answers "unsupported")
for (const name of ['meetingRecordingSupported', 'checkMeetingAudioAsync', 'startMeetingRecording', 'stopMeetingRecordingAsync', 'abortMeetingRecording']) {
  const Name = name[0].toUpperCase() + name.slice(1);
  assert.ok(bind.includes(`"backend_${name}", app.${Name}`), name + ' is bound');
  assert.ok(winGo.includes(`${name}:`) && macGo.includes(`${name}:`), name + ' is exposed to the page on both platforms');
}
assert.ok(/meetingShutdown\(\)/.test(winGo), 'the devices are released when the window closes');
console.log('PASS: the switch, its strings, the default, the bindings and the shutdown hook.');
console.log('\nAll meeting audio wiring tests PASSED!');
