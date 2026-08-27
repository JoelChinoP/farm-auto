import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const files = [
  "device-home.genfarm",
  "facebook-post-like-comment.genfarm",
  "open-social-content.genfarm",
  "tiktok-live-tap-tap.genfarm",
  "tiktok-post-like-comment.genfarm",
  "whatsapp-send-consented.genfarm",
];

type NodeData = {
  id: string;
  data: {
    successNode: string | null;
    failNode: string | null;
    startLoopNode?: string | null;
  };
};

type EdgeData = { source: string; target: string; sourceHandle: string };

type AutomationPackage = {
  name: string;
  input?: Array<{
    type: string;
    options: {
      value: unknown;
      variable?: { id: string; name: string; value: unknown };
    };
  }>;
  script: {
    id: string;
    variables: Array<{ id: string; name: string; value: unknown }>;
    flow: {
      nodes: Array<
        NodeData & {
          data: NodeData["data"] & {
            action?: string;
            options?: Record<string, unknown>;
          };
        }
      >;
      edges: EdgeData[];
    };
  };
};

for (const file of files) {
  test(`${file} is a complete package with matching graph pointers`, async () => {
    const text = await readFile(resolve(process.cwd(), "automations", file), "utf8");
    const parsed = JSON.parse(text) as AutomationPackage;

    assert.ok(parsed.name);
    assert.ok(parsed.script.id);
    const nodeIds = new Set(parsed.script.flow.nodes.map((node) => node.id));
    for (const node of parsed.script.flow.nodes) {
      for (const [pointer, handle] of [
        [node.data.successNode, "success"],
        [node.data.failNode, "fail"],
        [node.data.startLoopNode, "startLoopNode"],
      ] as const) {
        if (!pointer) continue;
        assert.ok(nodeIds.has(pointer), `${node.id} points to missing ${pointer}`);
        assert.ok(
          parsed.script.flow.edges.some(
            (edge) =>
              edge.source === node.id &&
              edge.target === pointer &&
              (node.id.endsWith("_start") || edge.sourceHandle === handle),
          ),
          `${node.id} -> ${pointer} has no matching edge`,
        );
      }
    }

    for (const variable of parsed.script.variables) {
      assert.equal(variable.value, "", `${file} embeds an operational value`);
    }
  });
}

test("open-social-content exposes its parameters and starts the selected app", async () => {
  const text = await readFile(
    resolve(process.cwd(), "automations", "open-social-content.genfarm"),
    "utf8",
  );
  const parsed = JSON.parse(text) as AutomationPackage;
  const variables = new Map(
    parsed.script.variables.map((variable) => [variable.id, variable]),
  );

  assert.deepEqual(
    parsed.input?.map((field) => field.options.variable?.name),
    ["contentUrl", "packageName"],
  );
  for (const field of parsed.input ?? []) {
    const variable = field.options.variable;
    assert.ok(variable, `${field.type} is not linked to a variable`);
    assert.equal(variable.value, "");
    assert.deepEqual(variable, variables.get(variable.id));
  }

  const startApp = parsed.script.flow.nodes.find(
    (node) => node.data.action === "StartApp",
  );
  assert.ok(startApp, "StartApp node is missing");
  assert.equal(startApp.data.options?.packageName, "${packageName}");

  const openContent = parsed.script.flow.nodes.find(
    (node) => node.data.action === "Adb",
  );
  assert.match(String(openContent?.data.options?.command), /\$\{contentUrl\}/);
});

test("facebook-post-like-comment preserves an existing like and uses approved text", async () => {
  const text = await readFile(
    resolve(process.cwd(), "automations", "facebook-post-like-comment.genfarm"),
    "utf8",
  );
  const parsed = JSON.parse(text) as AutomationPackage;

  assert.deepEqual(
    parsed.input?.map((field) => field.options.variable?.name),
    ["contentUrl", "commentText"],
  );
  assert.doesNotMatch(text, /api[_ -]?key|sk-[a-z0-9]/i);

  const startApp = parsed.script.flow.nodes.find(
    (node) => node.data.action === "StartApp",
  );
  assert.equal(startApp?.data.options?.packageName, "com.facebook.katana");

  const ensureLike = parsed.script.flow.nodes.find(
    (node) => node.data.action === "Javascript",
  );
  const likeScript = String(ensureLike?.data.options?.script);
  assert.match(likeScript, /likedXpath/);
  assert.match(likeScript, /android\.widget\.Button/);
  assert.match(likeScript, /contains\(@content-desc,'Me gusta'\)/);
  assert.match(likeScript, /likeButton\.click/);

  const typeComment = parsed.script.flow.nodes.find(
    (node) => node.data.action === "TypeText",
  );
  assert.equal(typeComment?.data.options?.text, "${commentText}");
  assert.match(
    String(typeComment?.data.options?.xpath),
    /android\.widget\.AutoCompleteTextView/,
  );
  assert.match(String(typeComment?.data.options?.xpath), /Comentar/);

  const sendComment = parsed.script.flow.nodes.find(
    (node) =>
      node.data.action === "Touch" &&
      String(node.data.options?.xpath).includes("Enviar"),
  );
  assert.ok(sendComment, "Facebook send-comment button selector is missing");
  assert.equal(
    parsed.script.flow.nodes.filter((node) => node.data.action === "Touch").length,
    2,
  );
});

test("tiktok-live-tap-tap opens TikTok and loops a bounded double touch", async () => {
  const text = await readFile(
    resolve(process.cwd(), "automations", "tiktok-live-tap-tap.genfarm"),
    "utf8",
  );
  const parsed = JSON.parse(text) as AutomationPackage;

  assert.deepEqual(
    parsed.input?.map((field) => field.options.variable?.name),
    ["liveUrl", "tapRounds", "tapX", "tapY"],
  );

  const startApp = parsed.script.flow.nodes.find(
    (node) => node.data.action === "StartApp",
  );
  assert.equal(
    startApp?.data.options?.packageName,
    "com.zhiliaoapp.musically",
  );

  const loop = parsed.script.flow.nodes.find(
    (node) => node.data.action === "Loop",
  );
  assert.equal(loop?.data.options?.loopType, "For");
  assert.equal(loop?.data.options?.forFrom, "1");
  assert.equal(loop?.data.options?.forTo, "${tapRounds}");
  assert.equal(loop?.data.startLoopNode, "live_double_tap");

  const touch = parsed.script.flow.nodes.find(
    (node) => node.data.action === "Touch",
  );
  assert.equal(touch?.data.options?.selectorBy, "coordinates");
  assert.equal(touch?.data.options?.touchType, "double");
  assert.equal(touch?.data.options?.x, "${tapX}");
  assert.equal(touch?.data.options?.y, "${tapY}");

  const failureLog = parsed.script.flow.nodes.find(
    (node) => node.id === "live_fail_log",
  );
  assert.match(String(failureLog?.data.options?.log), /^\[Failed\]/);
});

test("tiktok-post-like-comment uses approved text without embedding an API key", async () => {
  const text = await readFile(
    resolve(process.cwd(), "automations", "tiktok-post-like-comment.genfarm"),
    "utf8",
  );
  const parsed = JSON.parse(text) as AutomationPackage;

  assert.deepEqual(
    parsed.input?.map((field) => field.options.variable?.name),
    ["contentUrl", "commentText"],
  );
  assert.doesNotMatch(text, /api[_ -]?key|sk-[a-z0-9]/i);

  const actions = parsed.script.flow.nodes.map((node) => node.data.action);
  assert.deepEqual(
    actions.filter((action) =>
      ["StartApp", "TypeText", "PressHome"].includes(String(action)),
    ),
    ["StartApp", "TypeText", "PressHome"],
  );
  assert.equal(actions.filter((action) => action === "Touch").length, 2);

  const typeComment = parsed.script.flow.nodes.find(
    (node) => node.data.action === "TypeText",
  );
  assert.equal(typeComment?.data.options?.text, "${commentText}");

  const like = parsed.script.flow.nodes.find(
    (node) => node.id === "post_like",
  );
  assert.match(String(like?.data.options?.command), /input tap/);
});
