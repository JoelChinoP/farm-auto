import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeXmlEntities,
  flattenAndroidNodes,
  nodeLabel,
  parseAndroidHierarchy,
  parseBounds,
} from "../src/lib/android-ui.ts";

test("parses Android XML hierarchy, entities and bounds", () => {
  const roots = parseAndroidHierarchy(`<?xml version="1.0"?>
    <hierarchy>
      <node package="com.test" class="root" bounds="[0,0][1080,1920]">
        <node package="com.test" text="Café &amp; campo &#x1F331;" bounds="[10,20][300,90]" />
      </node>
    </hierarchy>`);
  const nodes = flattenAndroidNodes(roots);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[1].parent, nodes[0]);
  assert.equal(nodes[0].children[0], nodes[1]);
  assert.deepEqual(nodes[1].bounds, { left: 10, top: 20, right: 300, bottom: 90 });
  assert.equal(nodeLabel(nodes[1]), "cafe campo");
  assert.equal(decodeXmlEntities("&lt;x&gt;&quot;a&quot;&apos;"), `<x>"a"'`);
  assert.equal(parseBounds("[1,2][1,4]"), null);
});

test("parses UiAutomator2 class tags as Android nodes", () => {
  const nodes = flattenAndroidNodes(
    parseAndroidHierarchy(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <hierarchy rotation="0">
        <android.widget.FrameLayout package="com.test" bounds="[0,0][1080,1920]">
          <android.widget.TextView package="com.test" text="Objetivo real" bounds="[10,20][300,90]" />
        </android.widget.FrameLayout>
      </hierarchy>`),
  );
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].attributes.class, "android.widget.FrameLayout");
  assert.equal(nodes[1].attributes.class, "android.widget.TextView");
  assert.equal(nodes[1].parent, nodes[0]);
  assert.equal(nodeLabel(nodes[1]), "objetivo real");
});

test("handles comments and quoted >, then rejects unbalanced XML", () => {
  const nodes = flattenAndroidNodes(
    parseAndroidHierarchy(`<hierarchy><!-- ignored <node /> --><android.widget.TextView package="com.test" text="A > B" bounds="[0,0][10,10]" /></hierarchy>`),
  );
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].attributes.text, "A > B");
  assert.throws(
    () =>
      parseAndroidHierarchy(
        `<hierarchy><android.widget.FrameLayout><android.widget.TextView /></hierarchy>`,
      ),
    /desbalanceada/,
  );
});
