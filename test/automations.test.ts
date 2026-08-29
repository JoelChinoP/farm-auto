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
];

test("GenFarmer runs include the configured user ID", async () => {
  const source = await readFile(resolve(process.cwd(), "src", "lib", "genfarmer.ts"), "utf8");
  const createRun = source.slice(
    source.indexOf("export function createRun"),
    source.indexOf("export function getRun"),
  );

  assert.match(createRun, /userId:\s*appConfig\.genFarmerUserId/);
});

test("public Facebook context extraction is not registered in GenFarmer", async () => {
  const source = await readFile(
    resolve(process.cwd(), "src", "lib", "automation-service.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /slug:\s*["']facebook-context-extract["']/);
});

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

function uiNode(attributes: Record<string, string>) {
  return `<node ${Object.entries(attributes)
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ")} />`;
}

function hierarchy(...nodes: string[]) {
  return `<hierarchy>${nodes.join("")}</hierarchy>`;
}

function facebookPostContainer(...nodes: string[]) {
  return `<node package="com.facebook.katana" class="android.view.ViewGroup" bounds="[20,200][1060,1200]">${nodes.join("")}</node>`;
}

function facebookScreen(...nodes: string[]) {
  return `<node package="com.facebook.katana" class="android.widget.FrameLayout" bounds="[0,0][1080,1920]">${nodes.join("")}</node>`;
}

function facebookFeed(...nodes: string[]) {
  return `<node package="com.facebook.katana" class="androidx.recyclerview.widget.RecyclerView" scrollable="true" bounds="[0,80][1080,1920]">${nodes.join("")}</node>`;
}

async function runFacebookLocator(script: string, dumps: string[]) {
  const swipes: number[][] = [];
  const clicks: string[] = [];
  const variables: Record<string, string> = {
    commentText: "Este cultivo se ve excelente",
    facebookCommentBounds: "",
    facebookInterface: "target-marker-bound",
  };
  let dumpIndex = 0;
  let currentXml = dumps[0];
  const clientUiAutomator = {
    dumpWindowHierarchy: async () => {
      currentXml = dumps[Math.min(dumpIndex, dumps.length - 1)];
      dumpIndex++;
      return { xmlDump: currentXml };
    },
    xpath: async (xpath: string) => {
      const bounds = xpath.match(/@bounds='([^']+)'/)?.[1];
      if (!bounds || !currentXml.includes(`bounds="${bounds}"`)) return null;
      return {
        click: async () => {
          clicks.push(bounds);
        },
      };
    },
    swipe: async (...coordinates: number[]) => {
      swipes.push(coordinates);
    },
  };
  const testScript = script
    .replaceAll("${targetMarker}", "cosecha de verano sustentable")
    .replace(
      "const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));",
      "const wait = async () => {};",
    );
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction(testScript) as () => Promise<void>;
  let error: unknown = null;
  try {
    await execute.call({ clientUiAutomator, variables });
  } catch (caught) {
    error = caught;
  }
  return { clicks, swipes, variables, error };
}

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

test("facebook-post-like-comment verifies the target and the published comment", async () => {
  const text = await readFile(
    resolve(process.cwd(), "automations", "facebook-post-like-comment.genfarm"),
    "utf8",
  );
  const parsed = JSON.parse(text) as AutomationPackage;

  assert.deepEqual(
    parsed.input?.map((field) => field.options.variable?.name),
    ["contentUrl", "commentText", "targetMarker"],
  );
  assert.doesNotMatch(text, /api[_ -]?key|sk-[a-z0-9]/i);

  assert.equal(
    parsed.script.flow.nodes.some((node) => node.data.action === "StartApp"),
    false,
  );
  const openUrl = parsed.script.flow.nodes.find((node) => node.data.action === "Adb");
  assert.match(String(openUrl?.data.options?.command), /am start -W -S -a/);
  assert.match(String(openUrl?.data.options?.command), /\.IntentUriHandler/);
  assert.doesNotMatch(String(openUrl?.data.options?.command), /;/);
  assert.match(String(openUrl?.data.options?.command), /\$\{contentUrl\}/);

  const ensureLike = parsed.script.flow.nodes.find(
    (node) => node.id === "facebook_strict_target_action",
  );
  const likeScript = String(ensureLike?.data.options?.script);
  assert.match(likeScript, /\$\{targetMarker\}/);
  assert.match(likeScript, /node\.ancestors\.length >= 1/);
  assert.match(likeScript, /RecyclerView\|ListView\|ScrollView/);
  assert.match(likeScript, /unique\.length !== 1/);
  assert.doesNotMatch(likeScript, /clientUiAutomator\.swipe/);

  const verifyComment = parsed.script.flow.nodes.find(
    (node) => node.id === "facebook_strict_delivery",
  );
  assert.match(String(verifyComment?.data.options?.script), /this\.variables\.commentText/);
  assert.match(String(verifyComment?.data.options?.script), /android\.widget\.TextView/);
  assert.match(String(verifyComment?.data.options?.script), /composers/);
  assert.match(String(verifyComment?.data.options?.script), /node\.text === ''/);
  assert.equal(sendCommentNode(parsed)?.data.successNode, "facebook_strict_delivery");

  const openComments = parsed.script.flow.nodes.find(
    (node) => node.id === "facebook_open_comments",
  );
  assert.equal(
    openComments?.data.options?.xpath,
    "//*[@bounds='${facebookCommentBounds}']",
  );

  const typeComment = parsed.script.flow.nodes.find(
    (node) => node.data.action === "TypeText",
  );
  assert.equal(typeComment?.data.options?.text, "${commentText}");
  assert.match(
    String(typeComment?.data.options?.xpath),
    /android\.widget\.AutoCompleteTextView/,
  );
  assert.match(
    String(typeComment?.data.options?.xpath),
    /android\.widget\.MultiAutoCompleteTextView/,
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
  for (const node of parsed.script.flow.nodes.filter((item) =>
    ["Javascript", "Touch", "TypeText"].includes(String(item.data.action)),
  )) {
    assert.equal(node.data.options?.timeoutNextNode, "failNode");
  }
});

function sendCommentNode(parsed: AutomationPackage) {
  return parsed.script.flow.nodes.find((node) => node.id === "facebook_send_comment");
}

test("facebook locator acts only when the target marker and one action bar are visible", async () => {
  const text = await readFile(
    resolve(process.cwd(), "automations", "facebook-post-like-comment.genfarm"),
    "utf8",
  );
  const parsed = JSON.parse(text) as AutomationPackage;
  const script = String(
    parsed.script.flow.nodes.find((node) => node.id === "facebook_strict_target_action")
      ?.data.options?.script,
  );
  const screen = hierarchy(facebookScreen(facebookPostContainer(
    uiNode({
      package: "com.facebook.katana",
      class: "android.widget.TextView",
      text: "Cosecha de verano sustentable para la comunidad",
      bounds: "[40,300][1040,600]",
    }),
    uiNode({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      text: "",
      "content-desc": "Me gusta",
      clickable: "true",
      enabled: "true",
      bounds: "[80,1450][300,1550]",
    }),
    uiNode({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      text: "",
      "content-desc": "Comentar",
      clickable: "true",
      enabled: "true",
      bounds: "[360,1450][620,1550]",
    }),
  )));
  const result = await runFacebookLocator(script, [screen, screen]);
  assert.equal(result.error, null);
  assert.deepEqual(result.swipes, []);
  assert.deepEqual(result.clicks, ["[80,1450][300,1550]"]);
  assert.equal(result.variables.facebookCommentBounds, "[360,1450][620,1550]");
  assert.equal(result.variables.facebookInterface, "strict-target-verified");
});

test("facebook locator fails without touching a different feed post", async () => {
  const text = await readFile(
    resolve(process.cwd(), "automations", "facebook-post-like-comment.genfarm"),
    "utf8",
  );
  const parsed = JSON.parse(text) as AutomationPackage;
  const script = String(
    parsed.script.flow.nodes.find((node) => node.id === "facebook_strict_target_action")
      ?.data.options?.script,
  );
  const wrongPost = hierarchy(facebookScreen(facebookPostContainer(
    uiNode({
      package: "com.facebook.katana",
      class: "android.widget.TextView",
      text: "Una publicación distinta en el inicio",
      bounds: "[20,300][1040,700]",
    }),
    uiNode({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      text: "Me gusta",
      "content-desc": "Me gusta",
      clickable: "true",
      enabled: "true",
      bounds: "[80,1300][300,1400]",
    }),
    uiNode({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      text: "Comentar",
      "content-desc": "Comentar",
      clickable: "true",
      enabled: "true",
      bounds: "[360,1300][620,1400]",
    }),
  )));
  const result = await runFacebookLocator(script, [wrongPost]);
  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /contenedor de publicacion/);
  assert.deepEqual(result.clicks, []);
  assert.deepEqual(result.swipes, []);
});

test("facebook locator preserves an existing like on the verified target", async () => {
  const text = await readFile(
    resolve(process.cwd(), "automations", "facebook-post-like-comment.genfarm"),
    "utf8",
  );
  const parsed = JSON.parse(text) as AutomationPackage;
  const script = String(
    parsed.script.flow.nodes.find((node) => node.id === "facebook_strict_target_action")
      ?.data.options?.script,
  );
  const reel = hierarchy(facebookScreen(facebookPostContainer(
    uiNode({ package: "com.facebook.katana", class: "android.widget.TextView", text: "Cosecha de verano sustentable para la comunidad", bounds: "[20,300][1040,700]" }),
    uiNode({ package: "com.facebook.katana", class: "android.widget.ImageButton", "content-desc": "Unlike", clickable: "true", selected: "true", enabled: "true", bounds: "[80,900][300,1000]" }),
    uiNode({ package: "com.facebook.katana", class: "android.widget.ImageButton", "content-desc": "Comment", clickable: "true", enabled: "true", bounds: "[360,900][620,1000]" }),
  )));
  const reelResult = await runFacebookLocator(script, [reel]);
  assert.equal(reelResult.error, null);
  assert.deepEqual(reelResult.clicks, []);
  assert.equal(reelResult.variables.facebookInterface, "strict-target-verified");
  assert.equal(reelResult.variables.facebookCommentBounds, "[360,900][620,1000]");
});

test("facebook scrolled locator binds the main composer and ignores reply likes", async () => {
  const text = await readFile(
    resolve(process.cwd(), "automations", "facebook-post-like-comment.genfarm"),
    "utf8",
  );
  const parsed = JSON.parse(text) as AutomationPackage;
  const bindNode = parsed.script.flow.nodes.find(
    (node) => node.id === "facebook_refresh_visible_target",
  );
  const scrollNode = parsed.script.flow.nodes.find(
    (node) => node.id === "facebook_scroll_target",
  );
  const actionScript = String(
    parsed.script.flow.nodes.find(
      (node) => node.id === "facebook_bind_scrolled_controls",
    )?.data.options?.script,
  );

  assert.equal(bindNode?.data.successNode, "facebook_scroll_target");
  assert.match(String(scrollNode?.data.options?.command), /^input swipe /);
  const screen = hierarchy(facebookScreen(facebookPostContainer(
    uiNode({
      package: "com.facebook.katana",
      class: "android.widget.ImageButton",
      "content-desc": "",
      clickable: "true",
      bounds: "[40,800][140,900]",
    }),
    uiNode({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      "content-desc": "Comentar",
      clickable: "true",
      bounds: "[140,800][340,900]",
    }),
    uiNode({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      "content-desc": "Botón Compartir",
      clickable: "true",
      bounds: "[340,800][540,900]",
    }),
    uiNode({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      "content-desc": "Guardar publicación",
      clickable: "true",
      bounds: "[540,800][740,900]",
    }),
    uiNode({
      package: "com.facebook.katana",
      class: "android.widget.ImageButton",
      "content-desc": "Me gusta",
      clickable: "true",
      bounds: "[900,1200][1060,1300]",
    }),
    uiNode({
      package: "com.facebook.katana",
      class: "android.widget.EditText",
      hint: "Escribe un comentario...",
      focusable: "true",
      bounds: "[180,1500][1040,1650]",
    }),
  )));
  const result = await runFacebookLocator(actionScript, [screen]);
  assert.equal(result.error, null);
  assert.deepEqual(result.clicks, []);
  assert.equal(result.variables.facebookCommentBounds, "[180,1500][1040,1650]");
  assert.equal(result.variables.facebookLikeRequired, "false");
  assert.equal(result.variables.facebookInterface, "strict-target-scrolled");
});

test("facebook marker binding accepts ordered text split across accessible nodes", async () => {
  const text = await readFile(
    resolve(process.cwd(), "automations", "facebook-post-like-comment.genfarm"),
    "utf8",
  );
  const parsed = JSON.parse(text) as AutomationPackage;
  const script = String(
    parsed.script.flow.nodes.find((node) => node.id === "facebook_refresh_visible_target")
      ?.data.options?.script,
  );
  const target = hierarchy(facebookScreen(
    uiNode({
      package: "com.facebook.katana",
      class: "android.widget.TextView",
      text: "Cosecha de verano",
      bounds: "[40,300][1040,400]",
    }),
    uiNode({
      package: "com.facebook.katana",
      class: "android.widget.TextView",
      text: "sustentable para la comunidad",
      bounds: "[40,400][1040,500]",
    }),
  ));
  const matched = await runFacebookLocator(script, [target]);
  assert.equal(matched.error, null);
  assert.equal(matched.variables.facebookInterface, "target-marker-bound");

  const wrong = await runFacebookLocator(
    script,
    [hierarchy(facebookScreen(uiNode({
      package: "com.facebook.katana",
      class: "android.widget.TextView",
      text: "Otra publicación",
      bounds: "[40,300][1040,400]",
    })))],
  );
  assert.ok(wrong.error instanceof Error);
  assert.deepEqual(wrong.clicks, []);
});

test("facebook locator refuses an ambiguous screen with multiple action bars", async () => {
  const text = await readFile(
    resolve(process.cwd(), "automations", "facebook-post-like-comment.genfarm"),
    "utf8",
  );
  const parsed = JSON.parse(text) as AutomationPackage;
  const script = String(
    parsed.script.flow.nodes.find((node) => node.id === "facebook_strict_target_action")
      ?.data.options?.script,
  );
  const suggested = hierarchy(facebookScreen(facebookPostContainer(
    uiNode({ package: "com.facebook.katana", class: "android.widget.TextView", text: "Cosecha de verano sustentable para la comunidad", bounds: "[20,300][1040,600]" }),
    uiNode({ package: "com.facebook.katana", class: "android.widget.Button", text: "Me gusta", clickable: "true", enabled: "true", bounds: "[80,900][300,1000]" }),
    uiNode({ package: "com.facebook.katana", class: "android.widget.Button", text: "Comentar", clickable: "true", enabled: "true", bounds: "[360,900][620,1000]" }),
    uiNode({ package: "com.facebook.katana", class: "android.widget.Button", text: "Me gusta", clickable: "true", enabled: "true", bounds: "[80,1250][300,1350]" }),
    uiNode({ package: "com.facebook.katana", class: "android.widget.Button", text: "Comentar", clickable: "true", enabled: "true", bounds: "[360,1250][620,1350]" }),
  )));
  const result = await runFacebookLocator(script, [suggested]);
  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /contenedor de publicacion/);
  assert.equal(result.clicks.length, 0);
  assert.equal(result.swipes.length, 0);
});

test("facebook target binding rejects a marker and action bar in different posts", async () => {
  const text = await readFile(
    resolve(process.cwd(), "automations", "facebook-post-like-comment.genfarm"),
    "utf8",
  );
  const parsed = JSON.parse(text) as AutomationPackage;
  const script = String(
    parsed.script.flow.nodes.find((node) => node.id === "facebook_strict_target_action")
      ?.data.options?.script,
  );
  const screen = hierarchy(facebookScreen(
    facebookPostContainer(
      uiNode({ package: "com.facebook.katana", class: "android.widget.TextView", text: "Cosecha de verano sustentable para la comunidad", bounds: "[40,300][1040,600]" }),
    ),
    facebookPostContainer(
      uiNode({ package: "com.facebook.katana", class: "android.widget.Button", text: "", "content-desc": "Me gusta", bounds: "[80,900][300,1000]" }),
      uiNode({ package: "com.facebook.katana", class: "android.widget.Button", text: "", "content-desc": "Comentar", bounds: "[360,900][620,1000]" }),
    ),
  ));
  const result = await runFacebookLocator(script, [screen]);
  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /contenedor de publicacion/);
  assert.deepEqual(result.clicks, []);
});

test("facebook target binding rejects sibling posts under a global feed", async () => {
  const text = await readFile(
    resolve(process.cwd(), "automations", "facebook-post-like-comment.genfarm"),
    "utf8",
  );
  const parsed = JSON.parse(text) as AutomationPackage;
  const script = String(
    parsed.script.flow.nodes.find((node) => node.id === "facebook_strict_target_action")
      ?.data.options?.script,
  );
  const screen = hierarchy(facebookScreen(facebookFeed(
    facebookPostContainer(
      uiNode({ package: "com.facebook.katana", class: "android.widget.TextView", text: "Cosecha de verano sustentable para la comunidad", bounds: "[40,300][1040,600]" }),
    ),
    facebookPostContainer(
      uiNode({ package: "com.facebook.katana", class: "android.widget.Button", text: "", "content-desc": "Me gusta", bounds: "[80,900][300,1000]" }),
      uiNode({ package: "com.facebook.katana", class: "android.widget.Button", text: "", "content-desc": "Comentar", bounds: "[360,900][620,1000]" }),
    ),
  )));
  const result = await runFacebookLocator(script, [screen]);
  assert.ok(result.error instanceof Error);
  assert.deepEqual(result.clicks, []);
});

test("facebook delivery succeeds only when the approved comment is visible", async () => {
  const text = await readFile(
    resolve(process.cwd(), "automations", "facebook-post-like-comment.genfarm"),
    "utf8",
  );
  const parsed = JSON.parse(text) as AutomationPackage;
  const script = String(
    parsed.script.flow.nodes.find((node) => node.id === "facebook_strict_delivery")
      ?.data.options?.script,
  );
  const visibleComment = hierarchy(facebookScreen(facebookPostContainer(
    uiNode({ package: "com.facebook.katana", class: "android.widget.TextView", text: "Este cultivo se ve excelente", bounds: "[40,500][1040,650]" }),
    uiNode({ package: "com.facebook.katana", class: "android.widget.EditText", text: "", hint: "Escribe un comentario", bounds: "[40,1400][1040,1550]" }),
  )));
  const verified = await runFacebookLocator(script, [visibleComment]);
  assert.equal(verified.error, null);

  const missing = await runFacebookLocator(script, [hierarchy()]);
  assert.ok(missing.error instanceof Error);
  assert.match(missing.error.message, /reconciliacion manual/);

  const unsentComposer = hierarchy(facebookScreen(facebookPostContainer(
    uiNode({ package: "com.facebook.katana", class: "android.widget.EditText", text: "Este cultivo se ve excelente", bounds: "[40,1400][1040,1550]" }),
  )));
  const unsent = await runFacebookLocator(script, [unsentComposer]);
  assert.ok(unsent.error instanceof Error);

  const unrelatedButton = hierarchy(facebookScreen(facebookPostContainer(
    uiNode({ package: "com.facebook.katana", class: "android.widget.Button", text: "Este cultivo se ve excelente", bounds: "[40,500][1040,650]" }),
    uiNode({ package: "com.facebook.katana", class: "android.widget.EditText", text: "", hint: "Escribe un comentario", bounds: "[40,1400][1040,1550]" }),
  )));
  const falsePositive = await runFacebookLocator(script, [unrelatedButton]);
  assert.ok(falsePositive.error instanceof Error);

  const nonEmptyComposer = hierarchy(facebookScreen(facebookPostContainer(
    uiNode({ package: "com.facebook.katana", class: "android.widget.TextView", text: "Este cultivo se ve excelente", bounds: "[40,500][1040,650]" }),
    uiNode({ package: "com.facebook.katana", class: "android.widget.EditText", text: "Otro borrador", bounds: "[40,1400][1040,1550]" }),
  )));
  const nonEmpty = await runFacebookLocator(script, [nonEmptyComposer]);
  assert.ok(nonEmpty.error instanceof Error);

  const differentThreads = hierarchy(facebookScreen(facebookFeed(
    facebookPostContainer(
      uiNode({ package: "com.facebook.katana", class: "android.widget.TextView", text: "Este cultivo se ve excelente", bounds: "[40,500][1040,650]" }),
    ),
    facebookPostContainer(
      uiNode({ package: "com.facebook.katana", class: "android.widget.EditText", text: "", hint: "Escribe un comentario", bounds: "[40,1400][1040,1550]" }),
    ),
  )));
  const crossThread = await runFacebookLocator(script, [differentThreads]);
  assert.ok(crossThread.error instanceof Error);
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
