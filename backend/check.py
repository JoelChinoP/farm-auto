"""Local smoke check. It never opens GenFarmer, ADB or a device."""

import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

temporary = tempfile.TemporaryDirectory()
os.environ.update({
    "DATABASE_URL": f"sqlite:///{Path(temporary.name, 'farm.db')}",
    "GENFARMER_OPEN_APP_ID": "open-app",
    "GENFARMER_FACEBOOK_APP_ID": "facebook-app",
    "GENFARMER_FACEBOOK_LIVE_ROUNDS_APP_ID": "facebook-live-rounds-app",
    "GENFARMER_TIKTOK_APP_ID": "tiktok-app",
    "GENFARMER_DISPATCH_GAP": "0",
    "GENFARMER_COMPLETION_POLL": "0.1",
})

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app import comments  # noqa: E402
from app import genfarmer  # noqa: E402
from app.config import Settings  # noqa: E402
from app.context import classify_facebook, full_message, validate_url  # noqa: E402
from app.database import connect, init_database  # noqa: E402


for invalid_settings in ({"app_host": "0.0.0.0"}, {"frontend_url": "https://farm.example"}):
    try:
        Settings(**invalid_settings)
    except ValueError:
        pass
    else:
        raise AssertionError(invalid_settings)


contracts = {
    "open-content": {"contentUrl", "packageName"},
    "facebook": {"contentUrl", "like", "comment", "share", "commentText", "isPost", "isReel", "isVideo", "isLive", "diagnostic_only"},
    "facebook-live-rounds": {"contentUrl", "like", "comment", "share", "commentText", "isPost", "isReel", "isVideo", "isLive", "diagnostic_only"},
    "tiktok": {"contentUrl", "like", "comment", "share", "save", "commentText", "targetText"},
}
selector_contracts = {
    "facebook": {"toolbarLikePattern", "toolbarCommentPattern", "toolbarSharePattern", "commentEditorClassPattern",
                 "shareSubmitPattern", "publicAudiencePattern", "commentConfirmedPattern", "shareConfirmedPattern"},
    "facebook-live-rounds": {"toolbarLikePattern", "toolbarCommentPattern", "toolbarSharePattern", "commentEditorClassPattern",
                             "shareSubmitPattern", "publicAudiencePattern", "commentConfirmedPattern", "shareConfirmedPattern"},
    "tiktok": {"toolbarLikePattern", "toolbarCommentPattern", "toolbarSharePattern", "toolbarSavePattern", "commentEditorIdPattern",
               "shareSheetHeadingPattern", "copyLinkPattern", "repostActionPattern", "repostActivePattern",
               "liveCommentTriggerIdPattern", "liveCommentEditorIdPattern", "liveCommentSendIdPattern",
               "liveShareTriggerIdPattern", "liveShareActionPattern", "liveLikeContainerIdPattern"},
}
for path in Path(__file__).parent.joinpath("automations").glob("*.genfarm"):
    package = json.loads(path.read_text(encoding="utf-8"))
    node_ids = {node["id"] for node in package["script"]["flow"]["nodes"]}
    assert package["input"] and node_ids
    assert all(edge["source"] in node_ids and edge["target"] in node_ids for edge in package["script"]["flow"]["edges"])
    inputs = {item["options"]["variable"]["name"] for item in package["input"]}
    variables = {item["name"] for item in package["script"]["variables"]}
    assert inputs == contracts[path.stem], (path.name, inputs)
    assert inputs <= variables
    assert selector_contracts.get(path.stem, set()) <= variables
    samples = {
        "contentUrl": "https://www.facebook.com/share/p/19cmrzLH7p/",
        "packageName": "com.facebook.lite", "like": True, "comment": True,
        "share": True, "commentText": "¡Qué campaña mañana! 😊", "targetText": "texto visible", "save": True,
        "isPost": True, "isReel": False, "isVideo": False, "isLive": False, "diagnostic_only": False,
    }
    values = {name: samples[name] for name in inputs}
    package["id"] = f"{path.stem}-app"
    task = genfarmer.task_payload(package, values, {
        "connectionId": "usb-1", "id": "serial-1", "name": "Equipo 1",
    }, 7, "Contract check")
    assert {item["name"]: item["value"] for item in task["variables"] if item["name"] in values} == values
    assert {item["options"]["variable"]["name"]: item["options"]["value"] for item in task["input"]} == values
    scripts = "\n".join(node.get("data", {}).get("options", {}).get("script", "") for node in package["script"]["flow"]["nodes"])
    assert not any(old in scripts for old in ("v.do_like", "v.do_comment", "v.do_share", "v.comment_text", "v.expected_author", "v.expected_caption"))
    live = next((node for node in package["script"]["flow"]["nodes"] if node["id"] == "social_live_open"), None)
    if live:
        assert live["data"]["options"]["script"].count("await element.click()") == 1
        assert "attempts < 3" not in live["data"]["options"]["script"]
        if path.stem == "facebook":
            assert "com.facebook.katana" in live["data"]["options"]["script"]
            live_script = live["data"]["options"]["script"]
            assert "Detalles del video" in live_script
            assert "]/ancestor::*[@clickable='true'][1]" in live_script
            assert "ancestor::*[@resource-id='com.facebook.lite:id/videoview'" in live_script
            assert "not(ancestor::*[@class='androidx.recyclerview.widget.RecyclerView'])" not in live_script
            assert "clicks < 2 && check - lastClick >= 4" in live_script
    if path.stem == "open-content":
        assert package["version"] == package["script"]["version"] == "2.2.0"
        nodes = {node["id"]: node["data"] for node in package["script"]["flow"]["nodes"]}
        edges = package["script"]["flow"]["edges"]
        expected_edges = {(key, key if data["action"] == "Start" else handle, data[branch])
                          for key, data in nodes.items()
                          for branch, handle in (("successNode", "success"), ("failNode", "fail")) if data[branch]}
        assert {(edge["source"], edge["sourceHandle"], edge["target"]) for edge in edges} == expected_edges
        assert len(edges) == len(expected_edges)
        assert all(data["options"]["timeoutNextNode"] == "failNode" for data in nodes.values()
                   if data["action"] in {"Adb", "StartApp", "Javascript"})
        probe = r"""
const assert = require('node:assert/strict');
const nodes = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const validate = new Function(nodes.social_validate.options.script);
const fb = 'com.facebook.lite', tt = 'com.zhiliaoapp.musically';
for (const [packageName, contentUrl, expected] of [
  [fb, 'https://www.facebook.com/share/p/123/'],
  [fb, 'https://www.facebook.com/share/r/123/'],
  [fb, 'https://www.facebook.com/123/videos/456'],
  [fb, 'https://fb.watch/example'],
  [tt, 'https://www.tiktok.com/@example/video/7651603660060871954/?x=1', 'snssdk1233://aweme/detail/7651603660060871954'],
  [tt, 'https://www.tiktok.com/@example/live?x=1'],
  [tt, 'https://vm.tiktok.com/example'],
  [tt, 'https://vt.tiktok.com/example'],
]) {
  const variables = { packageName, contentUrl };
  validate.call({ variables });
  assert.equal(variables.contentUri, expected || contentUrl);
  const route = [];
  for (let id = 'social_start'; id && id !== 'social_live_ready';) {
    route.push(id);
    const node = nodes[id];
    id = node.action === 'If' && variables[node.options.leftOperand] !== node.options.rightOperand
      ? node.failNode : node.successNode;
  }
  assert.deepEqual(route, ['social_start', 'social_validate', 'social_wake', 'social_platform_facebook',
    ...(packageName === fb ? ['social_force_stop', 'social_open_app', 'social_content']
      : ['social_platform_tiktok', 'tiktok_force_stop', 'tiktok_content', 'social_success', 'social_stop'])]);
}
assert.equal(nodes.social_wake.options.command, 'input keyevent KEYCODE_WAKEUP');
assert.equal(nodes.tiktok_content.options.command, "am start -W -a android.intent.action.VIEW -d '${contentUri}' -p com.zhiliaoapp.musically");
assert.equal(nodes.tiktok_content.options.nodeSleep, '8');
for (const [packageName, contentUrl] of [
  [fb, 'https://www.tiktok.com/@example/live'], [tt, 'https://facebook.com/123'],
  ['invalid', 'https://tiktok.com/@example/live'], [tt, 'not a URL'],
  [tt, 'http://tiktok.com/@example/live'], [tt, 'https://tiktok.com.evil.example/video/1'],
  [tt, 'https://user:pass@tiktok.com/@example/live'], [tt, 'https://tiktok.com:444/@example/live'],
  [fb, "https://facebook.com/';input keyevent 3;'"], [tt, 'https://tiktok.com/a\nb'],
  [tt, 'https://tiktok.com/\x00'], [tt, 'https://tiktok.com/"'],
  [tt, 'https://tiktok.com/\\example'], [tt, 'https://tiktok.com/' + 'a'.repeat(2048)],
]) {
  const variables = { packageName, contentUrl, contentUri: 'stale' };
  assert.throws(() => validate.call({ variables }), /OPEN_INPUT_ERROR/);
  assert.equal(variables.contentUri, '');
  assert.match(variables.open_error, /HTTPS/);
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const openLive = new AsyncFunction('genfarmerSleep', nodes.social_live_open.options.script);
(async () => {
  for (const mode of ['ready', 'feed', 'preview', 'read-error', 'uncertain', 'missing', 'fatal']) {
    let reads = 0, clicks = 0;
    const ctx = {
      async getXml() {
        reads++;
        if (mode === 'read-error' && reads === 1) throw new Error('HTTP 503');
        if (mode === 'fatal') throw new Error('invalid selector');
        return '<hierarchy/>';
      },
      async queryXpath(xpath) {
        if (xpath.includes("ancestor::*[@resource-id='com.facebook.lite:id/videoview'"))
          return mode === 'ready' || (!['uncertain', 'missing'].includes(mode) && reads >= 4);
        if (mode === 'missing' || (mode === 'preview' && !xpath.includes('Video details'))) return null;
        return { async click() { clicks++; if (mode === 'uncertain') throw new Error('ECONNRESET'); } };
      },
    };
    const run = () => openLive.call(ctx, async () => {});
    if (['uncertain', 'missing'].includes(mode)) await assert.rejects(run, /No se pudo confirmar/);
    else if (mode === 'fatal') await assert.rejects(run, /invalid selector/);
    else await run();
    assert.equal(clicks, ['ready', 'missing', 'fatal'].includes(mode) ? 0 : 1, mode);
    if (mode === 'ready') assert.equal(reads, 2);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
"""
        subprocess.run(["node", "-e", probe], input=json.dumps(nodes), check=True, text=True)
    if path.stem == "facebook":
        assert package["version"] == package["script"]["version"] == "2.6.20"
        assert package["name"] == package["script"]["name"] and package["name"].endswith("v2.6.20")
        type_names = {"isPost", "isReel", "isVideo", "isLive"}
        assert all(item["value"] is False for item in package["script"]["variables"] if item["name"] in type_names)
        assert all(item["options"]["value"] is False and item["options"]["variable"]["value"] is False
                   for item in package["input"] if item["options"]["variable"]["name"] in type_names)
        assert next(item for item in package["input"] if item["options"]["variable"]["name"] == "diagnostic_only")["options"]["value"] is False
        assert "require('os').tmpdir()" in scripts
        assert "targetText" not in inputs and "targetText" not in scripts
        assert all(f"const is{kind.title()} = enabled(v.is{kind.title()});" in scripts for kind in ("post", "reel", "video", "live"))
        assert "[isPost, isReel, isVideo, isLive].filter(Boolean).length !== 1" in scripts
        assert "liveUrl" not in scripts
        assert "if (isLive) {" in scripts and "const live = await locateLive(12);" in scripts
        assert "locateLive(12, true)" not in scripts
        assert "publicAudiencePattern" in scripts and "amigos|friends" not in scripts
        assert "composer) { send = composer; audienceConfirmed = true" not in scripts
        audience_pattern = next(item["value"] for item in package["script"]["variables"] if item["name"] == "publicAudiencePattern")
        share_confirmed_pattern = next(item["value"] for item in package["script"]["variables"] if item["name"] == "shareConfirmedPattern")
        assert audience_pattern == "^(publico|public)\\b"
        # Lite expone el boton como "Publico. Toca dos veces para cambiar la audiencia...".
        assert re.search(audience_pattern, "publico. toca dos veces para cambiar la audiencia de esta publicacion concreta")
        assert re.search(audience_pattern, "public. double tap to change who can see this post")
        assert not re.search(audience_pattern, "amigos")
        assert re.search(share_confirmed_pattern, "compartiste esta publicacion.")
        assert "n.clickable === 'true' && liteSelectors.publicAudience.test(n.label)" in scripts
        assert "visual.lines.some(l => liteSelectors.publicAudience" not in scripts
        assert "reelExpandedCaption || descriptionCollapsed || liteCaptionOverlapsTime" in scripts
        assert ".filter(row => row.length === 3 && row.every(n => n.hasChildren))" in scripts
        assert (scripts.index("    if (actions.like) {") <
                scripts.index("    if (actions.share) {") <
                scripts.index("    if (actions.comment) {"))
        assert "marker || visual.liveBadge" in scripts and "function liteLiveBadge" in scripts
        assert "function liteLiveFeedVideo" in scripts
        assert scripts.count("/^(?:directo|l?ive)(?:\\s|$)/") == 1
        assert scripts.count("/^(?:en directo|directo|l?ive)(?:\\s|$)/") == 1
        assert "esta transmitiendo en (?:vivo|directo)" in scripts
        assert "if ((marker || visual.liveBadge) && announced)" in scripts
        assert not any(name in scripts for name in ("liteTargetMatches", "liteLiveUserMatches", "liteLiveFeedUser"))
        assert scripts.count("ancestor::*[@class='androidx.recyclerview.widget.RecyclerView']]/ancestor::*[@clickable='true'][1]") == 1
        assert scripts.count("await navigate(video);") == 1
        assert "feedOpened = true;\n              try { await element.click(); }" in scripts
        assert "\\b(?:para ti|reels?)\\b" in scripts
        assert "liteLiveShareEntry(nodes, visual)" in scripts
        assert "liteLiveShareComposer(nodes, visual)" in scripts
        assert "escribir publicacion(?: compartir como)?" in scripts
        share_helpers = scripts[scripts.index("function liteVisualButton"):scripts.index("function liteShareComposer")]
        subprocess.run(["node", "-e", """
const areaOf = node => (node.bounds[2] - node.bounds[0]) * (node.bounds[3] - node.bounds[1]);
""" + share_helpers + """
const entry = { clickable: 'true', enabled: 'true', bounds: [31, 940, 370, 1172] };
const visual = { width: 1080, height: 1920, lines: [
  { label: 'escribir publicacion compartir como', x: 42, y: 1086, width: 627, height: 35 }
] };
        if (liteLiveShareEntry([entry], visual) !== entry) throw new Error('merged Live share entry');
"""], check=True, capture_output=True, text=True)
        comment_helper = scripts[scripts.index("function comparableCommentText"):scripts.index("function sameLiteCaption")]
        subprocess.run(["node", "-e", comment_helper + """
const visual = { width: 1080, lines: [
  { label: 'prueba automatizada live v2.6.7 #1 5', x: 192, y: 325, width: 800, height: 45 },
  { label: 'lorenza moya', x: 192, y: 267, width: 300, height: 40 }
] };
const keys = liteCommentKeys(visual, { bounds: [24, 1666, 1056, 1769] }, 'prueba automatizada live v2.6.7 #15');
if (keys.length !== 1 || !keys[0].endsWith('|prueba automatizada live v2.6.7 #15')) {
  throw new Error('split comment digits');
}
visual.lines[0].label = 'prueba automatizada live v2.6.10';
const missingSuffix = liteCommentKeys(visual, { bounds: [24, 1666, 1056, 1769] }, 'prueba automatizada live v2.6.10 #19');
if (missingSuffix.length !== 1) throw new Error('missing trailing comment order');
visual.lines = [
  { label: 'phil caroll casimiro', x: 194, y: 1306, width: 370, height: 33 },
  { label: 'otra vez lo mismo, ya no se por quien', x: 193, y: 1364, width: 789, height: 47 },
  { label: 'votar', x: 192, y: 1431, width: 107, height: 33 },
  { label: 'hace un momento responder', x: 194, y: 1529, width: 585, height: 41 }
];
const wrapped = liteCommentKeys(visual, { bounds: [52, 1669, 853, 1764] }, 'otra vez lo mismo, ya no se por quien votar');
if (wrapped.length !== 1 || wrapped[0] !== 'phil caroll casimiro|otra vez lo mismo, ya no se por quien votar') {
  throw new Error('wrapped Live comment');
}
visual.lines = [{ label: 'felicidades por la boda', x: 192, y: 325, width: 800, height: 45 }];
const emoji = liteCommentKeys(visual, { bounds: [24, 1666, 1056, 1769] }, 'felicidades por la boda ' + String.fromCodePoint(0x1F389));
if (emoji.length !== 1 || !emoji[0].endsWith('|felicidades por la boda')) throw new Error('emoji comment');
"""], check=True, capture_output=True, text=True)
        dismiss_helper = scripts[scripts.index("async function dismissKeyboard"):scripts.index("async function scrollPost")]
        subprocess.run(["node", "-e", """
const stale = [
  { 'resource-id': 'com.facebook.lite:id/main_layout', bounds: [0, 63, 1080, 1794] },
  { scrollable: 'true', bounds: [0, 191, 1080, 1640] },
  { bounds: [0, 1794, 1080, 1920] }
];
const keyboard = [
  { 'resource-id': 'com.facebook.lite:id/main_layout', bounds: [0, 63, 1080, 917] },
  { scrollable: 'true', bounds: [0, 191, 1080, 763] },
  { bounds: [0, 917, 1080, 1794] },
  { bounds: [0, 1794, 1080, 1920] }
];
const closed = [
  { 'resource-id': 'com.facebook.lite:id/main_layout', bounds: [0, 63, 1080, 1794] },
  { scrollable: 'true', bounds: [0, 191, 1080, 1640] },
  { bounds: [0, 1794, 1080, 1920] }
];
let current = keyboard, presses = 0;
const ctx = { async getXml() { return '<hierarchy/>'; } };
function parseLiteXml() { return current; }
async function rpc(method) { if (method !== 'pressKey') throw new Error(method); presses++; }
async function wait() {}
async function screen() { current = closed; return current; }
""" + dismiss_helper + """
(async () => {
  const refreshed = await dismissKeyboard(stale);
  if (presses !== 1 || refreshed !== closed) throw new Error('stale keyboard hierarchy');
  current = closed;
  if (await dismissKeyboard(keyboard) !== closed || presses !== 1) throw new Error('fresh scroll hierarchy');
})().catch(error => { console.error(error); process.exitCode = 1; });
"""], check=True, capture_output=True, text=True)
        assert "({ nodes, edit } = await clearCorruptDraft(nodes, edit));" in scripts
        assert scripts.count("await clearCorruptDraft(nodes, edit)") == 2
        assert "includes('\ufffd')" in scripts
        assert "const commentText = String(v.commentText || '').trim();" in scripts
        assert "function liteCommentText" not in scripts
        assert "async function writeDraft(edit, text)" in scripts
        assert "await ui.sendKeys(text, true);" in scripts
        assert scripts.count("await writeDraft(edit, commentText);") == 2
        assert "function comparableCommentText(value)" in scripts
        assert "function hasEmoji(value)" in scripts
        assert "editorTextMatches" not in scripts
        assert scripts.count("!hasEmoji(commentText) && edit.text !== commentText") == 2
        assert "rpc('setText'" not in scripts
        editor_helper = scripts[scripts.index("function comparableCommentText"):scripts.index("function parseLiteXml")]
        subprocess.run(["node", "-e", editor_helper + """
const assert = require('node:assert/strict');
assert.equal(hasEmoji('Boda ' + String.fromCodePoint(0x1F389)), true);
assert.equal(hasEmoji('Boda ' + String.fromCodePoint(0x1F1F5, 0x1F1EA)), true);
assert.equal(hasEmoji('Boda 1' + String.fromCodePoint(0xFE0F, 0x20E3)), true);
assert.equal(hasEmoji('Boda normal!'), false);
"""], check=True, capture_output=True, text=True)
        assert "if (liveMode && keys.length === 0 && (i === 0 || i === 2))" in scripts
        assert "await scrollPost(edit ? await dismissKeyboard(nodes) : nodes, i === 2, true)" in scripts
        assert "await scrollPost(nodes, true, true)" in scripts
        assert "if (!optional && error.message !== 'Operacion UI no confirmada: swipe') throw error;" in scripts
        assert scripts.count("result.swipeReplyUncertain = (result.swipeReplyUncertain || 0) + 1;") == 1
        scroll_helper = scripts[scripts.index("async function scrollPost"):scripts.index("async function locatePost")]
        subprocess.run(["node", "-e", """
const result = {};
const reel = false;
const areaOf = node => (node.bounds[2] - node.bounds[0]) * (node.bounds[3] - node.bounds[1]);
let errorMessage = 'Operacion UI no confirmada: swipe';
async function rpc() { throw new Error(errorMessage); }
async function wait() {}
""" + scroll_helper + """
(async () => {
  const nodes = [{ scrollable: 'true', bounds: [0, 0, 100, 100] }];
  await scrollPost(nodes);
  if (result.swipeReplyUncertain !== 1) throw new Error('uncertain swipe');
  if (await scrollPost([], false, true) !== false) throw new Error('optional missing scroll');
  try { await scrollPost([]); throw new Error('missing strict failure'); }
  catch (error) { if (error.message !== 'No se encontro el contenedor desplazable de la publicacion.') throw error; }
   errorMessage = 'fatal';
   if (await scrollPost(nodes, false, true) !== false) throw new Error('optional fatal failure');
   try { await scrollPost(nodes); throw new Error('missing failure'); }
  catch (error) { if (error.message !== 'fatal') throw error; }
})().catch(error => { console.error(error); process.exitCode = 1; });
"""], check=True, capture_output=True, text=True)
        toast_helpers = scripts[scripts.index("async function resetToast"):scripts.index("async function confirm")]
        subprocess.run(["node", "-e", """
let toastEnabled = true, calls = 0;
async function rpc() { calls++; throw new Error('socket hang up'); }
""" + toast_helpers + """
(async () => {
  await resetToast();
  if (toastEnabled || calls !== 1) throw new Error('toast reset fallback');
  if (await toast() !== '' || calls !== 1) throw new Error('disabled toast fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });
"""], check=True, capture_output=True, text=True)
        assert "for (let i = 0; i < 16 && !edit; i++)" in scripts
        assert scripts.count("await navigate(live.bar.comment);") == 1
        assert scripts.count("result.actions.comment = 'pending'; save();\n        await tap(send);") == 2
        live_helper = scripts[scripts.index("function liteLiveFeedVideo"):scripts.index("function liteSendButton")]
        live_nodes = [
            {"resource-id": "com.facebook.lite:id/main_layout", "bounds": [0, 63, 1080, 1776]},
            {"resource-id": "com.facebook.lite:id/video_view", "bounds": [0, 420, 1080, 1638]},
            *[{"class": "android.view.ViewGroup", "clickable": "true", "enabled": "true", "hasChildren": True,
               "bounds": [left, 1647, left + 360, 1767]} for left in (0, 360, 720)],
            {"resource-id": "android:id/navigationBarBackground", "bounds": [0, 1776, 1080, 1920]},
        ]
        subprocess.run(["node", "-e", live_helper +
                        f"\nconst row = liteLiveToolbar({json.dumps(live_nodes)});" +
                        "if (!row || row.like.bounds[0] !== 0 || row.share.bounds[2] !== 1080) throw new Error('live row');"],
                       check=True, capture_output=True, text=True)
        feed_nodes = [
            {"resource-id": "com.facebook.lite:id/main_layout", "bounds": [0, 63, 1080, 1776]},
            {"resource-id": "com.facebook.lite:id/video_view", "bounds": [0, 762, 1080, 1776]},
        ]
        subprocess.run(["node", "-e", live_helper +
                        f"\nconst video = liteLiveFeedVideo({json.dumps(feed_nodes)});" +
                        "if (!video || video.bounds[1] !== 762) throw new Error('live feed video');"],
                       check=True, capture_output=True, text=True)
        locate_live = scripts[scripts.index("async function locateLive"):scripts.index("async function runLive")]
        subprocess.run(["node", "-e", """
const assert = require('node:assert/strict');
let latestXml = '', liveIdentity = '';
const result = {};
const feed = [{ feed: true }], player = [{ player: true }];
let screens = 0, clicks = 0;
async function screen() { latestXml = screens++ ? 'player-xml' : 'feed-xml'; return screens === 1 ? feed : player; }
function liteLiveToolbar(nodes) { return { like: {}, comment: {}, share: {} }; }
function liteLiveFeedVideo(nodes) { return nodes === feed ? nodes[0] : null; }
function normalizeLiteText(value) { return value.toLowerCase(); }
function transient() { return false; }
async function wait() {}
async function recognize(label) {
  return label.endsWith('-feed')
    ? { width: 1080, height: 1920, liveBadge: false, lines: [
        { label: 'en directo' }, { label: 'alice esta transmitiendo en vivo' }
      ] }
    : { width: 1080, height: 1920, liveBadge: false, lines: [
        { label: 'directo', y: 10, height: 20, x: 10, width: 100 },
        { label: '< videos', y: 60, height: 30, x: 10, width: 200 }
      ] };
}
const ctx = { async queryXpath(xpath, xml) {
  assert.ok(xpath.includes('RecyclerView') && xpath.includes("ancestor::*[@clickable='true'][1]"));
  assert.equal(xml, 'feed-xml');
  return { async click() { clicks++; } };
} };
""" + locate_live + """
(async () => {
  const live = await locateLive(1);
  assert.ok(live && live.bar);
  assert.equal(liveIdentity, 'alice');
  assert.equal(clicks, 1);
})().catch(error => { console.error(error); process.exitCode = 1; });
"""], check=True, capture_output=True, text=True)
        facebook_nodes = {node["id"]: node["data"] for node in package["script"]["flow"]["nodes"]}
        assert facebook_nodes["social_content"]["successNode"] == "social_success"
        assert not ({"social_live_ready", "social_live_detect", "social_live_detect_variant", "social_live_detect_vivo", "social_live_open"} & facebook_nodes.keys())
        expected_edges = {(key, key if data["action"] == "Start" else handle, data[branch])
                          for key, data in facebook_nodes.items()
                          for branch, handle in (("successNode", "success"), ("failNode", "fail")) if data[branch]}
        assert {(edge["source"], edge["sourceHandle"], edge["target"])
                for edge in package["script"]["flow"]["edges"]} == expected_edges
        assert len(package["script"]["flow"]["edges"]) == len(expected_edges)
    if path.stem == "facebook-live-rounds":
        assert package["version"] == package["script"]["version"] == "1.0.2"
        assert package["name"] == package["script"]["name"] and "rondas" in package["name"].lower()
    if path.stem == "tiktok":
        assert package["version"] == package["script"]["version"] == "1.3.0"
        assert "repostActionPattern" in scripts and "^(compartir|republicar" not in scripts
        assert "/compartido|republicado|shared|reposted/" not in scripts
        assert scripts.count("await ui.sendKeys(text, true);") == 2
        assert "rpc('setText'" not in scripts and "tap(edit)" not in scripts
        assert "await clickOnce(edit, text ? 'enfocar comentario Live'" in scripts
        assert "republier" in scripts and "envoyer a" in scripts and "copier le lien" in scripts and "partager une video" in scripts
        video_script = next(node["data"]["options"]["script"] for node in package["script"]["flow"]["nodes"]
                            if node["id"] == "tiktok_actions")
        assert video_script.index("if (actions.like) {") < video_script.index("if (actions.save) {") < video_script.index("if (actions.comment) {") < video_script.index("if (actions.share) {")
        assert "Guardar no esta disponible en TikTok Live." in scripts
        variables_by_name = {item["name"]: item["value"] for item in package["script"]["variables"]}
        assert variables_by_name["diagnostic_only"] is False
        assert "video con me gusta" in variables_by_name["toolbarLikePattern"]
        assert scripts.count("video con me gusta") == 2
        assert "tiktokIdentityMatches" not in scripts
        assert "locateVideo(null, 90, true)" in scripts
        assert "locateVideo(null, 90, true, expectedTarget)" not in scripts
        editor_helper = scripts[scripts.index("function tiktokCommentEditor"):scripts.index("function tiktokSendButton")]
        subprocess.run(["node", "-e", """
const assert = require('node:assert/strict');
const tiktokSelectors = { commentEditorId: /:id\\/de5$/ };
""" + editor_helper + """
const nodes = [
  { class: 'android.widget.EditText', 'resource-id': 'com.zhiliaoapp.musically:id/de5', text: 'Agregar comentario\u2026', focused: 'false', bounds: [189, 1661, 721, 1739] },
  { class: 'android.widget.EditText', 'resource-id': 'com.zhiliaoapp.musically:id/de5', text: 'eso pandia hay que apoyar', focused: 'true', bounds: [189, 803, 1011, 940] },
];
assert.equal(tiktokCommentEditor(nodes).text, 'eso pandia hay que apoyar');
assert.equal(tiktokCommentEditor(nodes, 'eso pandia hay que apoyar').text, 'eso pandia hay que apoyar');
assert.equal(tiktokCommentEditor(nodes, 'otro texto'), null);
assert.equal(tiktokCommentEditor([nodes[0]]).text, 'Agregar comentario\u2026');
"""], check=True, capture_output=True, text=True)
        send_helper = scripts[scripts.index("function tiktokSendButton"):scripts.index("function tiktokCommentKeys")]
        subprocess.run(["node", "-e", send_helper + """
const assert = require('node:assert/strict');
const edit = { bounds: [189, 511, 1011, 648] };
const nodes = [
  edit,
  { class: 'android.widget.ImageView', 'resource-id': 'com.zhiliaoapp.musically:id/b4f', clickable: 'true', bounds: [995, 611, 1048, 664] },
  { class: 'android.widget.ImageView', 'resource-id': 'com.zhiliaoapp.musically:id/wql', clickable: 'true', bounds: [942, 711, 1059, 828] },
  { class: 'android.widget.Button', 'resource-id': 'com.zhiliaoapp.musically:id/c5t', clickable: 'true', bounds: [927, 718, 1048, 792] },
];
const send = tiktokSendButton(nodes, edit);
assert.equal(send && send['resource-id'], 'com.zhiliaoapp.musically:id/c5t');
const inline = [
  { bounds: [189, 1661, 721, 1739] },
  { class: 'android.widget.ImageView', clickable: 'true', bounds: [900, 1661, 1010, 1739] },
];
assert.equal(tiktokSendButton(inline, inline[0])['bounds'][0], 900);
assert.equal(tiktokSendButton(nodes, null), null);
"""], check=True, capture_output=True, text=True)
        liked_helper = scripts[scripts.index("function tiktokLikedState"):scripts.index("function tiktokActionCount")]
        subprocess.run(["node", "-e", liked_helper + """
const assert = require('node:assert/strict');
assert.equal(tiktokLikedState({ label: 'video con me gusta' }), true);
assert.equal(tiktokLikedState({ label: 'dar me gusta a un video. 250,5 mil me gusta' }), false);
assert.equal(tiktokLikedState({ label: 'me gusta', selected: 'true' }), true);
assert.equal(tiktokLikedState({ label: 'me gusta' }), null);
"""], check=True, capture_output=True, text=True)
        live_script = next(node["data"]["options"]["script"] for node in package["script"]["flow"]["nodes"]
                           if node["id"] == "tiktok_live_publish")
        assert live_script.index("  if (actions.comment) {") < live_script.index("  if (actions.like) {") < live_script.index("  if (actions.share) {")
        assert "No se repetira" in live_script and "result.json" in live_script
        assert "targetMatches" not in live_script
        live_validation = next(line for line in live_script.splitlines() if "TikTok Live valido" in line)
        live_regex = re.search(r"if \(!(/.+?/i)\.test\(", live_validation).group(1)
        subprocess.run(["node", "-e", f"""
const assert = require('node:assert/strict');
const pattern = {live_regex};
assert.equal(pattern.test('https://www.tiktok.com/@belenm.ar/live?_r=1&enter_from_merge=pc_share'), true);
assert.equal(pattern.test('https://www.tiktok.com/@belenm.ar/live/'), true);
assert.equal(pattern.test('https://www.tiktok.com/@belenm.ar/video/7687442603788340501'), false);
"""], check=True, capture_output=True, text=True)

facebook_package = json.loads(Path(__file__).parent.joinpath("automations/facebook.genfarm").read_text(encoding="utf-8"))
rounds_package = json.loads(Path(__file__).parent.joinpath("automations/facebook-live-rounds.genfarm").read_text(encoding="utf-8"))
assert rounds_package["input"] == facebook_package["input"]
assert rounds_package["script"]["variables"] == facebook_package["script"]["variables"]
assert rounds_package["script"]["flow"] == facebook_package["script"]["flow"]

html_fixture = '<script>{"story":{"message":{"text":"Primera parte \\u00a1Hola!\\n\\nSegunda parte con m\\u00e1s contexto"}}}</script>'
assert full_message(html_fixture, "Primera parte ¡Hola!") == "Primera parte ¡Hola! Segunda parte con más contexto"
assert full_message(html_fixture, "Texto de otra publicacion") == "Texto de otra publicacion"
assert full_message(html_fixture, "") == ""
assert full_message("<html>sin json</html>", "Primera parte") == "Primera parte"

context_limit = "x" * 2000
assert main.Publication(url="https://www.facebook.com/example/posts/1", context=context_limit).context == context_limit
assert main.CommentsRequest(platform="facebook", context=context_limit,
                            profiles=[{"deviceId": "serial-first", "intention": "Apoyo", "tone": "Cercano"}]).context == context_limit
for tone in ("Dulce / Cálido", "Empático / Asertivo", "Distante / Formal", "Pasivo-Agresivo / Sarcástico", "Frío / Cortante", "Defensivo / Agresivo"):
    assert main.CommentProfile(deviceId="serial-first", intention="Apoyo", tone=tone).tone == tone
for factory in (
    lambda: main.Publication(url="https://www.facebook.com/example/posts/1", context=context_limit + "x"),
    lambda: main.CommentsRequest(platform="facebook", context=context_limit + "x",
                                 profiles=[{"deviceId": "serial-first", "intention": "Apoyo", "tone": "Cercano"}]),
):
    try:
        factory()
    except ValueError:
        pass
    else:
        raise AssertionError("Contexto mayor de 2000 caracteres aceptado")

assert classify_facebook("https://www.facebook.com/reel/123", "", "video.other", "LIVE\nAlice is now live") == "reel"
assert classify_facebook("https://www.facebook.com/1/videos/2", "", "video.other", "DIRECTO\nEstá transmitiendo en vivo") == "live"
assert classify_facebook("https://www.facebook.com/1/videos/2", "", "video.other", "Alice is now live") == "video"
assert classify_facebook("https://www.facebook.com/1/videos/2", "", "video.other", "DIRECTO") == "video"
assert classify_facebook("https://www.facebook.com/1/videos/2", "", "video.other", "Video finalizado") == "video"
assert classify_facebook("https://www.facebook.com/user/posts/3", "", "video.other", "Publicación") == "post"
assert classify_facebook("https://www.facebook.com/share/p/4", "", "article", "Publicación") == "post"

for url, platform in [
    ("https://www.facebook.com/example/posts/1", "facebook"),
    ("https://fb.watch/example", "facebook"),
    ("https://www.tiktok.com/@example/video/1", "tiktok"),
    ("https://www.tiktok.com/@example/live", "tiktok"),
    ("https://www.facebook.com/share/p/19cmrzLH7p/", "facebook"),
    ("https://www.facebook.com/share/r/1FAw8USyZo/", "facebook"),
    ("https://www.tiktok.com/@joeln_c/video/7651603660060871954", "tiktok"),
]:
    assert validate_url(url, platform) == url
assert validate_url("https://www.tiktok.com/@example/live", "tiktok", True)
for url, platform in [
    ("http://facebook.com/example", "facebook"),
    ("https://evil.example", "facebook"),
    ('https://www.tiktok.com/@example/video/1"', "tiktok"),
    ("https://www.facebook.com/'%3Binput%20keyevent%203%3B'", "facebook"),
]:
    try:
        validate_url(url, platform)
    except ValueError:
        pass
    else:
        raise AssertionError((url, platform))
assert validate_url("https://vm.tiktok.com/example", "tiktok")
try:
    validate_url("https://vm.tiktok.com/example", "tiktok", True)
except ValueError:
    pass
else:
    raise AssertionError("TikTok actions must use a canonical video or Live URL")


calls = []
reject_run = {"enabled": False}
fake_state = {"tasks": 0, "runs": 0, "runStates": {}}
real_request = genfarmer.request


def fake_workflow(app_id, names):
    return {
        "id": app_id,
        "input": [{"options": {"variable": {"name": name, "value": ""}, "value": ""}} for name in names],
        "script": {"variables": [{"name": name, "value": ""} for name in names]},
    }


open_workflow = fake_workflow("open-app", ["contentUrl", "packageName"])
facebook_workflow = fake_workflow("facebook-app", ["contentUrl", "like", "comment", "share", "commentText", "isPost", "isReel", "isVideo", "isLive"])
facebook_live_rounds_workflow = fake_workflow("facebook-live-rounds-app", ["contentUrl", "like", "comment", "share", "commentText", "isPost", "isReel", "isVideo", "isLive"])
tiktok_workflow = fake_workflow("tiktok-app", ["contentUrl", "like", "comment", "share", "save", "commentText", "targetText"])


def fake_request(path, method="GET", data=None):
    calls.append((path, method, data))
    if path == "/automation/devices":
        return [
            {"serialNo": "serial-second", "currentDeviceId": "usb-2", "name": "Segundo", "index": 2},
            {"serialNo": "serial-first", "currentDeviceId": "usb-1", "name": "Primero", "index": 1},
        ]
    if path == "/automation/apps/open-app":
        return open_workflow
    if path == "/automation/apps/facebook-app":
        return facebook_workflow
    if path == "/automation/apps/facebook-live-rounds-app":
        return facebook_live_rounds_workflow
    if path == "/automation/apps/tiktok-app":
        return tiktok_workflow
    if path == "/automation/tasks" and method == "POST":
        fake_state["tasks"] += 1
        return {"taskId": f"task-{fake_state['tasks']}"}
    if path.startswith("/automation/tasks/task-") and method == "PUT":
        return {}
    if path == "/automation/runs" and method == "POST":
        if reject_run["enabled"]:
            raise genfarmer.GenFarmerError("run rejected")
        fake_state["runs"] += 1
        run_id = f"run-{fake_state['runs']}"
        fake_state["runStates"][run_id] = {"taskId": data["taskId"], "status": 1, "deviceStatus": 1}
        return {"runId": run_id}
    if path.startswith("/automation/runs/run-") and method == "GET":
        run_id = path.rsplit("/", 1)[-1]
        state = fake_state["runStates"].get(run_id)
        if state is None:
            return {"deviceStorages": 0}
        return {"id": run_id, "taskId": state["taskId"], "status": state["status"],
                "finishedAt": state.get("finishedAt"),
                "deviceStatuses": [{"runId": run_id, "deviceId": "usb-1", "status": state["deviceStatus"]}]}
    raise AssertionError((path, method, data))


def finish_run(run_id):
    fake_state["runStates"][run_id].update(status=4, deviceStatus=2)
    main.dispatch_wakeup.set()


def abandon_run(run_id):
    # GenFarmer puede cerrar el run sin que el dispositivo llegue a iniciar.
    fake_state["runStates"][run_id].update(status=4, deviceStatus=0, finishedAt="2026-01-01T00:00:00.000Z")
    main.dispatch_wakeup.set()


main.genfarmer.request = fake_request
main.genfarmer.user_id = lambda: 7


def fake_inspect_facebook(url):
    validate_url(url, "facebook")
    content_type = next((kind for kind in ("reel", "video", "live") if f"/{kind}/" in url), "post")
    return {"type": content_type, "context": "Contexto publico", "resolvedUrl": url}


main.inspect_facebook = fake_inspect_facebook

payload = {
    "requestId": "123e4567-e89b-12d3-a456-426614174000",
    "platform": "facebook",
    "kind": "open",
    "deviceIds": ["serial-first"],
    "publications": [{"url": "https://www.facebook.com/example/posts/1", "context": "", "comments": {}}],
    "actions": {"like": False, "comment": False, "share": False},
    "scheduledAt": None,
}

with TestClient(main.app) as client:
    origin = {"Origin": "http://localhost:5173"}
    devices = client.get("/api/devices").json()["devices"]
    assert [device["id"] for device in devices] == ["serial-first", "serial-second"]
    assert client.post("/api/submissions", json=payload).status_code == 403
    assert client.post("/api/submissions", json=payload, headers={"Origin": "https://evil.example"}).status_code == 403
    created = client.post("/api/submissions", json=payload, headers=origin)
    assert created.status_code == 201, created.text
    submission = created.json()["submissions"][0]
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        current = client.get("/api/submissions").json()["submissions"][0]
        if current["status"] in {"sent", "failed", "unknown"}:
            break
        time.sleep(0.02)
    assert current["status"] == "sent", current
    assert current["taskId"] == "task-1" and current["runId"] == "run-1"
    replay = client.post("/api/submissions", json=payload, headers=origin)
    assert replay.status_code == 200 and replay.json()["submissions"][0]["id"] == submission["id"]
    assert len([call for call in calls if call[:2] == ("/automation/runs", "POST")]) == 1
    task_call = next(call for call in calls if call[:2] == ("/automation/tasks", "POST"))
    assert task_call[2]["devices"]["list"] == [{"id": "usb-1", "serialNo": "serial-first", "name": "Primero"}]
    assert {item["name"]: item["value"] for item in task_call[2]["variables"]} == {
        "contentUrl": payload["publications"][0]["url"], "packageName": "com.facebook.lite",
    }
    assert not [call for call in calls if call[:2] == ("/automation/runs/run-1/run", "PUT")]
    finish_run("run-1")

    chained = {**payload, "requestId": "123e4567-e89b-12d3-a456-426614174005",
               "publications": [
                   {"url": "https://www.facebook.com/example/posts/2", "context": "", "comments": {}},
                   {"url": "https://www.facebook.com/example/posts/3", "context": "", "comments": {}},
               ]}
    response = client.post("/api/submissions", json=chained, headers=origin)
    assert response.status_code == 201, response.text
    chained_ids = [item["id"] for item in response.json()["submissions"]]
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        current = {item["id"]: item for item in client.get("/api/submissions").json()["submissions"]}
        if current[chained_ids[0]]["status"] == "sent":
            break
        time.sleep(0.02)
    first_run = current[chained_ids[0]]["runId"]
    assert first_run and current[chained_ids[1]]["status"] == "scheduled", current
    runs_before = fake_state["runs"]
    fake_state["runStates"][first_run]["status"] = 4
    main.dispatch_wakeup.set()
    time.sleep(0.2)
    current = {item["id"]: item for item in client.get("/api/submissions").json()["submissions"]}
    assert current[chained_ids[1]]["status"] == "scheduled" and fake_state["runs"] == runs_before
    finish_run(first_run)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        current = {item["id"]: item for item in client.get("/api/submissions").json()["submissions"]}
        if current[chained_ids[1]]["status"] == "sent":
            break
        time.sleep(0.02)
    assert current[chained_ids[1]]["status"] == "sent", current
    assert [call for call in calls if call[:2] == (f"/automation/runs/{first_run}", "GET")]
    finish_run(current[chained_ids[1]]["runId"])

    timestamp = main.now_ms()
    scheduled = {**chained, "requestId": "123e4567-e89b-12d3-a456-426614174001",
                 "deviceIds": ["serial-first", "serial-second"], "scheduledAt": timestamp + 60_000}
    draws = [timestamp + offset for offset in (50_000, 10_000, 40_000, 20_000)]
    with patch.object(main, "now_ms", return_value=timestamp), patch.object(main.random, "randint", side_effect=draws) as draw:
        response = client.post("/api/submissions", json=scheduled, headers=origin)
    assert draw.call_count == 4 and all(call.args == (timestamp, scheduled["scheduledAt"]) for call in draw.call_args_list)
    assert response.status_code == 201, response.text
    planned = response.json()["submissions"]
    assert [row["scheduledAt"] for row in planned] == [timestamp + offset for offset in (10_000, 20_000, 50_000, 40_000)]
    with patch.object(main.random, "randint", side_effect=AssertionError("Do not reschedule a replay")):
        replay = client.post("/api/submissions", json=scheduled, headers=origin)
    assert replay.status_code == 200 and replay.json()["submissions"] == planned
    assert client.post("/api/submissions", json={**payload, "scheduledAt": timestamp + 31 * 86_400_000,
                                               "requestId": str(main.uuid4())}, headers=origin).status_code == 422
    for pending in planned:
        cancelled = client.delete(f"/api/submissions/{pending['id']}", headers=origin)
        assert cancelled.status_code == 200 and cancelled.json()["submission"]["status"] == "cancelled"
    assert client.post("/api/context", json={"url": "https://www.tiktok.com/@example/video/1"}, headers=origin).status_code == 422
    inspected = client.post("/api/context", json={"url": "https://www.facebook.com/example/posts/1"}, headers=origin)
    assert inspected.status_code == 200 and inspected.json()["type"] == "post" and inspected.json()["source"] == "playwright"
    too_long = {**payload, "requestId": "123e4567-e89b-12d3-a456-426614174002", "platform": "tiktok",
                "kind": "actions", "actions": {"like": False, "comment": True, "share": False},
                "publications": [{"url": "https://www.tiktok.com/@example/video/1", "context": "",
                                  "comments": {"serial-first": "x" * 151}}]}
    assert client.post("/api/submissions", json=too_long, headers=origin).status_code == 422
    assert client.post("/api/submissions", json={**payload, "requestId": "123e4567-e89b-12d3-a456-426614174017",
                                                "actions": {"like": False, "comment": False, "share": False, "save": True}},
                       headers=origin).status_code == 422
    saved = {**payload, "requestId": "123e4567-e89b-12d3-a456-426614174016", "platform": "tiktok",
             "kind": "actions", "actions": {"like": True, "save": True, "comment": False, "share": False},
             "publications": [{"url": "https://www.tiktok.com/@example/video/7651603660060871954", "context": "", "comments": {}}]}
    response = client.post("/api/submissions", json=saved, headers=origin)
    assert response.status_code == 201, response.text
    saved_id = response.json()["submissions"][0]["id"]
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        saved_row = next(item for item in client.get("/api/submissions").json()["submissions"] if item["id"] == saved_id)
        if saved_row["status"] == "sent":
            break
        time.sleep(0.02)
    assert saved_row["status"] == "sent", saved_row
    saved_task = next(call[2] for call in reversed(calls) if call[:2] == ("/automation/tasks", "POST")
                      and call[2]["appId"] == "tiktok-app")
    saved_values = {item["name"]: item["value"] for item in saved_task["variables"]}
    assert saved_values["save"] is True and saved_values["like"] is True and saved_values["comment"] is False
    assert saved_values["targetText"] == ""
    finish_run(saved_row["runId"])
    commented = {**payload, "requestId": "123e4567-e89b-12d3-a456-426614174004",
                 "kind": "actions", "deviceIds": ["serial-first", "serial-second"],
                 "actions": {"like": True, "comment": True, "share": False},
                  "publications": [{"url": "https://www.facebook.com/example/posts/1", "context": "texto visible",
                                    "comments": {"serial-first": "¡Qué campaña mañana! 😊",
                                                 "serial-second": "Niñez, acción y corazón 🇵🇪"}}]}
    response = client.post("/api/submissions", json=commented, headers=origin)
    assert response.status_code == 201, response.text
    commented_ids = {item["id"] for item in response.json()["submissions"]}
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        current = [item for item in client.get("/api/submissions").json()["submissions"] if item["id"] in commented_ids]
        if len(current) == 2 and all(item["status"] == "sent" for item in current):
            break
        time.sleep(0.02)
    assert len(current) == 2 and all(item["status"] == "sent" for item in current), current
    per_device = {}
    facebook_flags = {}
    for call in calls:
        if call[:2] == ("/automation/tasks", "POST") and call[2]["appId"] == "facebook-app":
            values = {item["name"]: item["value"] for item in call[2]["variables"]}
            per_device[call[2]["devices"]["list"][0]["serialNo"]] = values["commentText"]
            facebook_flags = {name: values[name] for name in ("isPost", "isReel", "isVideo", "isLive")}
    assert per_device == {"serial-first": "¡Qué campaña mañana! 😊",
                          "serial-second": "Niñez, acción y corazón 🇵🇪"}, per_device
    assert facebook_flags == {"isPost": True, "isReel": False, "isVideo": False, "isLive": False}
    assert "targetText" not in values
    for item in current:
        finish_run(item["runId"])
    for index, content_type in enumerate(("reel", "video", "live"), start=7):
        typed = {**payload, "requestId": f"123e4567-e89b-12d3-a456-4266141740{index:02d}", "kind": "actions",
                 "actions": {"like": True, "comment": False, "share": False},
                 "publications": [{"url": f"https://www.facebook.com/{content_type}/1", "context": "", "comments": {}}]}
        response = client.post("/api/submissions", json=typed, headers=origin)
        assert response.status_code == 201, response.text
        typed_id = response.json()["submissions"][0]["id"]
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            typed_row = next(item for item in client.get("/api/submissions").json()["submissions"] if item["id"] == typed_id)
            if typed_row["status"] == "sent":
                break
            time.sleep(0.02)
        assert typed_row["status"] == "sent", typed_row
        task = next(call[2] for call in reversed(calls) if call[:2] == ("/automation/tasks", "POST")
                    and any(item["name"] == "contentUrl" and item["value"] == typed["publications"][0]["url"]
                            for item in call[2]["variables"]))
        flags = {item["name"]: item["value"] for item in task["variables"] if item["name"] in {"isPost", "isReel", "isVideo", "isLive"}}
        assert flags == {f"is{kind.title()}": kind == content_type for kind in ("post", "reel", "video", "live")}
        finish_run(typed_row["runId"])

    live_rounds = {**payload, "requestId": "123e4567-e89b-12d3-a456-426614174012",
                   "kind": "live_rounds", "rounds": 2, "deviceIds": ["serial-second", "serial-first"],
                   "actions": {"like": False, "comment": True, "share": False},
                   "publications": [{"url": "https://www.facebook.com/live/rounds", "context": "",
                                     "comments": {"serial-first": "¡Vamos con todo! 😊",
                                                  "serial-second": "¡Vamos con todo! 😊"}}]}
    response = client.post("/api/submissions", json=live_rounds, headers=origin)
    assert response.status_code == 201, response.text
    round_rows = response.json()["submissions"]
    assert [row["deviceId"] for row in round_rows] == ["serial-first", "serial-second"] * 2
    assert all(row["kind"] == "live_rounds" for row in round_rows)
    round_ids = [row["id"] for row in round_rows]
    for position, round_id in enumerate(round_ids):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            current_rows = {item["id"]: item for item in client.get("/api/submissions").json()["submissions"]}
            if current_rows[round_id]["status"] == "sent":
                break
            time.sleep(0.02)
        assert current_rows[round_id]["status"] == "sent", current_rows[round_id]
        assert all(current_rows[pending_id]["status"] == "scheduled" for pending_id in round_ids[position + 1:])
        round_task = next(call[2] for call in reversed(calls) if call[:2] == ("/automation/tasks", "POST")
                          and call[2]["name"].startswith("Farm Live ronda ")
                          and call[2]["devices"]["list"][0]["serialNo"] == current_rows[round_id]["deviceId"])
        round_values = {item["name"]: item["value"] for item in round_task["variables"]}
        assert round_task["appId"] == "facebook-live-rounds-app"
        assert round_values["commentText"] == "¡Vamos con todo! 😊"
        assert {name: round_values[name] for name in ("isPost", "isReel", "isVideo", "isLive")} == {
            "isPost": False, "isReel": False, "isVideo": False, "isLive": True,
        }
        finish_run(current_rows[round_id]["runId"])

    invalid_rounds = {**live_rounds, "requestId": "123e4567-e89b-12d3-a456-426614174013",
                      "publications": [{**live_rounds["publications"][0], "comments": {
                          "serial-first": "Comentario uno", "serial-second": "Comentario dos",
                      }}]}
    assert client.post("/api/submissions", json=invalid_rounds, headers=origin).status_code == 422
    not_live = {**live_rounds, "requestId": "123e4567-e89b-12d3-a456-426614174014",
                "publications": [{**live_rounds["publications"][0], "url": "https://www.facebook.com/video/rounds"}]}
    assert client.post("/api/submissions", json=not_live, headers=origin).status_code == 422
    too_many_rounds = {**live_rounds, "requestId": "123e4567-e89b-12d3-a456-426614174015", "rounds": 101}
    assert client.post("/api/submissions", json=too_many_rounds, headers=origin).status_code == 422

    reject_run["enabled"] = True
    rejected_run = {**payload, "requestId": "123e4567-e89b-12d3-a456-426614174003"}
    response = client.post("/api/submissions", json=rejected_run, headers=origin)
    assert response.status_code == 201, response.text
    rejected_id = response.json()["submissions"][0]["id"]
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        rejected = next(item for item in client.get("/api/submissions").json()["submissions"] if item["id"] == rejected_id)
        if rejected["status"] in {"failed", "unknown"}:
            break
        time.sleep(0.02)
    assert rejected["status"] == "unknown", rejected
    blocked = {**payload, "requestId": "123e4567-e89b-12d3-a456-426614174006"}
    response = client.post("/api/submissions", json=blocked, headers=origin)
    assert response.status_code == 201, response.text
    blocked_id = response.json()["submissions"][0]["id"]
    main.dispatch_wakeup.set()
    time.sleep(0.2)
    blocked_row = next(item for item in client.get("/api/submissions").json()["submissions"] if item["id"] == blocked_id)
    assert blocked_row["status"] == "scheduled" and blocked_row["taskId"] is None, blocked_row
    assert client.delete(f"/api/submissions/{blocked_id}", headers=origin).status_code == 200
    reject_run["enabled"] = False

with connect() as db:
    db.execute("UPDATE submissions SET status='sending' WHERE id=?", (submission["id"],))
init_database()
with connect() as db:
    assert db.execute("SELECT status FROM submissions WHERE id=?", (submission["id"],)).fetchone()[0] == "unknown"

# Persist a future schedule with the worker stopped; restart after its time has passed.
timestamp = main.now_ms()
overdue = {**payload, "requestId": str(main.uuid4()), "deviceIds": ["serial-second"], "scheduledAt": timestamp - 10_000}
with patch.object(main, "now_ms", return_value=timestamp - 60_000), patch.object(main.random, "randint", side_effect=lambda start, end: end):
    response = main.submit(main.SubmissionRequest(**overdue))
pending = json.loads(response.body)["submissions"][0]
assert pending["status"] == "scheduled" and pending["scheduledAt"] == overdue["scheduledAt"]
tasks_before = fake_state["tasks"]
with TestClient(main.app) as client:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        current = next(item for item in client.get("/api/submissions").json()["submissions"] if item["id"] == pending["id"])
        if current["status"] == "sent":
            break
        time.sleep(0.02)
    assert current["status"] == "sent" and fake_state["tasks"] == tasks_before + 1, current
    finish_run(current["runId"])
    # A limit already in the past is accepted and dispatched immediately.
    response = client.post("/api/submissions", json={**overdue, "requestId": str(main.uuid4()), "scheduledAt": 1}, headers=origin)
    assert response.status_code == 201, response.text
    pending = response.json()["submissions"][0]
    assert pending["scheduledAt"] is None
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        current = next(item for item in client.get("/api/submissions").json()["submissions"] if item["id"] == pending["id"])
        if current["status"] == "sent":
            break
        time.sleep(0.02)
    assert current["status"] == "sent" and fake_state["tasks"] == tasks_before + 2, current
    finish_run(current["runId"])
    # GenFarmer borro su historial: el run anterior ausente libera el equipo sin reenviarlo.
    purged_run = current["runId"]
    del fake_state["runStates"][purged_run]
    released = client.post("/api/submissions", json={**overdue, "requestId": str(main.uuid4())}, headers=origin)
    assert released.status_code == 201, released.text
    released_id = released.json()["submissions"][0]["id"]
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        rows = client.get("/api/submissions").json()["submissions"]
        predecessor = next(item for item in rows if item["id"] == current["id"])
        released_row = next(item for item in rows if item["id"] == released_id)
        if released_row["status"] == "sent":
            break
        time.sleep(0.02)
    assert released_row["status"] == "sent" and predecessor["status"] == "sent", (released_row, predecessor)
    assert predecessor["runId"] == purged_run and ("/automation/runs/" + purged_run, "GET", None) in calls
    finish_run(released_row["runId"])
    # GenFarmer cerro el run sin iniciar el dispositivo: libera el equipo sin reenviarlo.
    abandoned = client.post("/api/submissions", json={**overdue, "requestId": str(main.uuid4())}, headers=origin)
    assert abandoned.status_code == 201, abandoned.text
    abandoned_id = abandoned.json()["submissions"][0]["id"]
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        abandoned_row = next(item for item in client.get("/api/submissions").json()["submissions"] if item["id"] == abandoned_id)
        if abandoned_row["status"] == "sent":
            break
        time.sleep(0.02)
    assert abandoned_row["status"] == "sent", abandoned_row
    abandon_run(abandoned_row["runId"])
    following = client.post("/api/submissions", json={**overdue, "requestId": str(main.uuid4())}, headers=origin)
    assert following.status_code == 201, following.text
    following_id = following.json()["submissions"][0]["id"]
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        following_row = next(item for item in client.get("/api/submissions").json()["submissions"] if item["id"] == following_id)
        if following_row["status"] == "sent":
            break
        time.sleep(0.02)
    assert following_row["status"] == "sent" and following_row["runId"] != abandoned_row["runId"], following_row
    assert next(item for item in client.get("/api/submissions").json()["submissions"] if item["id"] == abandoned_id)["status"] == "sent"
    finish_run(following_row["runId"])


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self):
        return self.body


class FakeDeepSeek:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self):
        return self.body


unique_key = comments.settings.api_deepseek
comments.settings.api_deepseek = "test-key"
try:
    with TestClient(main.app) as client:
        origin = {"Origin": "http://localhost:5173"}
        request = {"platform": "facebook", "context": "Un texto visible de prueba",
                    "profiles": [
                        {"deviceId": "serial-first", "intention": "Elogio o Apoyo", "tone": "Dulce / Cálido"},
                        {"deviceId": "serial-second", "intention": "Pregunta", "tone": "Informativo"},
                    ]}
        content = json.dumps({"comments": [
            {"deviceId": "serial-first", "text": "Comentario generado de prueba uno"},
            {"deviceId": "serial-second", "text": "Comentario generado de prueba dos"},
        ]})
        body = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
        captured_requests = []

        def capture_deepseek(outgoing, **_):
            captured_requests.append(json.loads(outgoing.data))
            return FakeDeepSeek(body)

        with patch.object(comments, "urlopen", side_effect=capture_deepseek):
            generated = client.post("/api/comments", json=request, headers=origin)
        assert generated.status_code == 200, generated.text
        prompted_profiles = json.loads(captured_requests[0]["messages"][1]["content"])["profiles"]
        assert prompted_profiles[0]["intentionGuidance"] == comments.INTENTION_GUIDANCE["Elogio o Apoyo"]
        assert prompted_profiles[0]["toneGuidance"] == comments.TONE_GUIDANCE["Dulce / Cálido"]
        assert generated.json()["comments"] == [
            {"deviceId": "serial-first", "text": "Comentario generado de prueba uno"},
            {"deviceId": "serial-second", "text": "Comentario generado de prueba dos"},
        ]
        short = json.dumps({"choices": [{"message": {"content": json.dumps({"comments": [
            {"deviceId": "serial-first", "text": "Comentario generado de prueba uno"},
        ]})}}]}).encode()
        with patch.object(comments, "urlopen", return_value=FakeDeepSeek(short)):
            invalid = client.post("/api/comments", json=request, headers=origin)
        assert invalid.status_code == 502, invalid.text
finally:
    comments.settings.api_deepseek = unique_key


for body, ambiguous in [
    (b'{"success":false,"message":"rejected"}', False),
    (b'{"message":"missing envelope"}', True),
    (b'[]', True),
]:
    with patch.object(genfarmer, "urlopen", return_value=FakeResponse(body)):
        try:
            real_request("/automation/tasks", "POST", {})
        except genfarmer.GenFarmerError as error:
            assert error.ambiguous is ambiguous
        else:
            raise AssertionError(body)

print("backend/check.py: ok")
temporary.cleanup()
