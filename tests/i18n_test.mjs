import fs from 'fs';
import vm from 'vm';

const html = fs.readFileSync('frontend/index.html', 'utf8');
const appJs = fs.readFileSync('frontend/js/app.js', 'utf8');
const i18nJs = fs.readFileSync('frontend/js/i18n.js', 'utf8');

const context = {};
vm.createContext(context);
vm.runInContext(i18nJs + '; this.I18N = I18N;', context);
const I18N = context.I18N;

console.log('=== Evaluation Driven Testing for i18n Integrity ===');

// 1. Verify specific keys reported by user
const reportedKeys = [
  'cliOpenNewTabLabel',
  'cliOpenErrorTabLabel',
  'btnBrowse',
  'gitRemoteUrlLabel',
  'btnGitSetup',
  'gitRemoteUrlHint'
];

for (const key of reportedKeys) {
  if (!I18N.en[key]) throw new Error('Missing EN key: ' + key);
  if (!I18N.ja[key]) throw new Error('Missing JA key: ' + key);
  console.log(`PASS: Key "${key}" -> JA: "${I18N.ja[key]}"`);
}

// 2. Verify all data-i18n, data-i18n-title, data-i18n-placeholder in HTML
const textKeys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]);
const titleKeys = [...html.matchAll(/data-i18n-title="([^"]+)"/g)].map(m => m[1]);
const placeholderKeys = [...html.matchAll(/data-i18n-placeholder="([^"]+)"/g)].map(m => m[1]);
const allHtmlKeys = [...new Set([...textKeys, ...titleKeys, ...placeholderKeys])];

const missingEnHtml = allHtmlKeys.filter(k => I18N.en[k] === undefined);
const missingJaHtml = allHtmlKeys.filter(k => I18N.ja[k] === undefined);
if (missingEnHtml.length > 0) throw new Error('Missing HTML EN keys: ' + missingEnHtml.join(', '));
if (missingJaHtml.length > 0) throw new Error('Missing HTML JA keys: ' + missingJaHtml.join(', '));

console.log(`PASS: All ${allHtmlKeys.length} HTML data-i18n attributes have valid translations in EN & JA.`);

// 3. Verify all t() calls in app.js
const tKeys = [...appJs.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
const uniqueTKeys = [...new Set(tKeys)];
const missingEnApp = uniqueTKeys.filter(k => I18N.en[k] === undefined);
const missingJaApp = uniqueTKeys.filter(k => I18N.ja[k] === undefined);
if (missingEnApp.length > 0) throw new Error('Missing app.js EN keys: ' + missingEnApp.join(', '));
if (missingJaApp.length > 0) throw new Error('Missing app.js JA keys: ' + missingJaApp.join(', '));

console.log(`PASS: All ${uniqueTKeys.length} dynamic t() calls in app.js have valid translations in EN & JA.`);
console.log('All i18n evaluation tests passed with 0 error(s)!');
