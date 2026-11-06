'use strict';
/**
 * ScopeDesk application catalog (single source of truth).
 *
 * - The task form shows ONLY the clean `name` (never a file name or extension).
 * - `processes` are the executable stems the host agent compares against (lower case, no extension).
 * - The server stores clean names; agent/sandbox-guard.js resolves them to processes with this file.
 *
 * Deliberately NOT in the catalog (and rejected by cleanAppName even if typed by hand): command shells, script hosts,
 * registry/task managers and installers. A vendor with a shell can undo every other restriction.
 */

const CATALOG = [
  { name: 'File Manager',      processes: ['explorer', 'file explorer', 'files', 'finder', 'nautilus', 'dolphin', 'thunar', 'nemo'] },
  { name: 'Notepad',           processes: ['notepad'] },
  { name: 'Notepad++',         processes: ['notepad++'] },
  { name: 'Calculator',        processes: ['calculator', 'calculatorapp', 'calc', 'gnome-calculator', 'org.gnome.calculator', 'kcalc', 'galculator'] },
  { name: 'Paint',             processes: ['mspaint', 'paint'] },
  { name: 'WordPad',           processes: ['wordpad'] },
  { name: 'Snipping Tool',     processes: ['snippingtool', 'screenclippinghost'] },
  { name: 'Photos',            processes: ['photos', 'microsoft.photos'] },
  { name: 'Media Player',      processes: ['wmplayer', 'mediaplayer', 'microsoft.media.player'] },
  { name: 'Excel',             processes: ['excel', 'microsoft excel'] },
  { name: 'Word',              processes: ['winword', 'microsoft word'] },
  { name: 'PowerPoint',        processes: ['powerpnt', 'microsoft powerpoint'] },
  { name: 'Outlook',           processes: ['outlook', 'microsoft outlook'] },
  { name: 'Access',            processes: ['msaccess'] },
  { name: 'OneNote',           processes: ['onenote', 'microsoft onenote'] },
  { name: 'Adobe Acrobat',     processes: ['acrobat', 'acrord32', 'acrord64'] },
  { name: 'Chrome',            processes: ['chrome', 'google chrome'] },
  { name: 'Edge',              processes: ['msedge', 'microsoft edge'] },
  { name: 'Firefox',           processes: ['firefox'] },
  { name: 'Brave',             processes: ['brave'] },
  { name: 'Visual Studio Code', processes: ['code', 'visual studio code'] },
  { name: 'Sublime Text',      processes: ['sublime_text', 'sublime text'] },
  { name: 'QuickBooks',        processes: ['qbw32', 'qbw64', 'quickbooks'] },
  { name: 'Tally',             processes: ['tally', 'tallyprime'] },
  { name: 'OpenVPN',           processes: ['openvpn-gui', 'openvpn_gui', 'openvpn'] },
  { name: 'Billing Manager',   processes: ['billing_manager', 'billingmanager', 'billing'] },
  { name: 'Printer Settings',  processes: ['printui', 'systemsettings'] },
  { name: '7-Zip',             processes: ['7zfm', '7-zip', '7zip'] },
  { name: 'WinRAR',            processes: ['winrar'] },
  { name: 'VLC',               processes: ['vlc'] },
  { name: 'Zoom',              processes: ['zoom'] },
  { name: 'WhatsApp',          processes: ['whatsapp', 'whatsapp.root', 'whatsappdesktop'] },
  { name: 'Microsoft Teams',   processes: ['teams', 'ms-teams', 'microsoft teams'] },
  { name: 'TextEdit',          processes: ['textedit'] },
  { name: 'Preview',           processes: ['preview'] },
  { name: 'Numbers',           processes: ['numbers'] },
  { name: 'Pages',             processes: ['pages'] },
  { name: 'Safari',            processes: ['safari'] },
  { name: 'LibreOffice',       processes: ['soffice', 'libreoffice'] },
  { name: 'gedit',             processes: ['gedit'] }
];

// The "file manager". It can be ticked in the form (as "File Manager") and it is also always recognised by the guard,
// but it only ever opens inside the approved folders, whether or not it was ticked.
const FILE_MANAGERS = new Set(['explorer', 'file explorer', 'file manager', 'filemanager', 'files', 'finder', 'nautilus', 'dolphin', 'thunar', 'nemo']);

// Refused as an allowed app, whatever the Client types.
const BLOCKED = new Set([
  'cmd', 'command', 'powershell', 'powershell_ise', 'pwsh', 'wscript', 'cscript', 'mshta', 'regedit', 'regedt32',
  'rundll32', 'taskmgr', 'msiexec', 'wmic', 'bash', 'sh', 'zsh', 'fish', 'terminal', 'iterm', 'iterm2', 'wt',
  'windowsterminal', 'conhost', 'psexec', 'schtasks', 'sc', 'net', 'reg', 'certutil', 'bitsadmin', 'installer'
]);

const EXECUTABLE_EXT = /\.(exe|app|msi|bat|cmd|com|lnk|scr|ps1|jar|dmg|pkg|bin|sh|appx|msix)$/i;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._\-()+&]{0,63}$/u;

/** "C:\Apps\Billing.EXE" -> "Billing", "Excel.app" -> "Excel". Returns null when the name is unusable. */
function cleanAppName(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFKC').trim();
  if (!s || s.length > 260 || /[\u0000-\u001f\u007f]/.test(s)) return null;
  s = s.split(/[\\/]/).pop().trim();              // drop any folder part
  s = s.replace(EXECUTABLE_EXT, '').trim();       // drop ONE trailing executable extension
  s = s.replace(/\s+/g, ' ');
  if (!NAME_RE.test(s)) return null;
  return s;
}

/** Lower-case, extension-less, path-less key used for every comparison. */
function appKey(raw) {
  const c = cleanAppName(raw);
  return c ? c.toLowerCase() : null;
}

/** Display form: the catalog's own spelling when the name is known ("excel.app" -> "Excel"), else the cleaned name. */
function canonicalName(raw) {
  const clean = cleanAppName(raw);
  if (!clean) return null;
  const hit = CATALOG.find((a) => a.name.toLowerCase() === clean.toLowerCase());
  return hit ? hit.name : clean;
}

function isBlockedApp(raw) {
  const k = appKey(raw);
  return !k || BLOCKED.has(k) || BLOCKED.has(k.replace(/[ .\-]/g, ''));
}

function isFileManager(raw) {
  const k = appKey(raw);
  return !!k && FILE_MANAGERS.has(k);
}

/** Clean names for the task form (names only). */
function listAppNames() {
  return CATALOG.map((a) => a.name);
}

/** Search words per app ("File Manager" is also found by typing "explorer"), used by the form's search box. */
function listAliases() {
  const out = {};
  for (const a of CATALOG) out[a.name] = a.processes.filter((p) => p !== a.name.toLowerCase());
  return out;
}

/**
 * The list the form shows: the built-in matrix (always present, so the picker is never empty) plus any extra
 * programs a Client's PC reported. Every name is cleaned, blocked tools are dropped, duplicates are merged.
 */
function mergeAppLists(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const raw of Array.isArray(list) ? list : []) {
      const name = canonicalName(raw);
      if (!name || isBlockedApp(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** All process keys an approved app name stands for (the clean name itself plus any catalog aliases). */
function processKeysFor(appName) {
  const key = appKey(appName);
  if (!key) return [];
  const keys = new Set([key, key.replace(/[ .\-]/g, '')]);
  // Match on the squashed name too, so "filemanager" / "file-manager" / "File Manager" all mean the same catalog entry
  const squash = (v) => String(v).toLowerCase().replace(/[ .\-_]/g, '');
  const hit = CATALOG.find((a) => a.name.toLowerCase() === key || squash(a.name) === squash(key));
  if (hit) hit.processes.forEach((p) => keys.add(p));
  return [...keys];
}

/** Is this running/requested process one of the approved apps? */
function isAppAllowed(processName, allowedAppNames) {
  const key = appKey(processName);
  if (!key || BLOCKED.has(key)) return false;
  const squashed = key.replace(/[ .\-]/g, '');
  return (allowedAppNames || []).some((name) => {
    const keys = processKeysFor(name);
    return keys.includes(key) || keys.includes(squashed);
  });
}

module.exports = { CATALOG, BLOCKED, FILE_MANAGERS, cleanAppName, canonicalName, appKey, isBlockedApp, isFileManager, listAppNames, listAliases, mergeAppLists, processKeysFor, isAppAllowed };
