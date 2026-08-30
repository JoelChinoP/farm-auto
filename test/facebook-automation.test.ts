import assert from "node:assert/strict";
import test from "node:test";

import {
  locateFacebookTarget,
  verifyFacebookDelivery,
} from "../src/lib/facebook-automation.ts";

const node = (attributes: Record<string, string>, children = "") =>
  `<node ${Object.entries(attributes)
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ")}>${children}</node>`;
const leaf = (attributes: Record<string, string>) => node(attributes);
const post = (children: string, bounds = "[20,200][1060,1500]") =>
  node(
    {
      package: "com.facebook.katana",
      class: "android.view.ViewGroup",
      bounds,
    },
    children,
  );
const screen = (children: string) =>
  `<hierarchy>${node(
    {
      package: "com.facebook.katana",
      class: "androidx.recyclerview.widget.RecyclerView",
      scrollable: "true",
      bounds: "[0,0][1080,1920]",
    },
    children,
  )}</hierarchy>`;
const marker = leaf({
  package: "com.facebook.katana",
  class: "android.widget.TextView",
  text: "Cosecha de verano sustentable para la comunidad",
  bounds: "[40,300][1040,600]",
});
const like = (selected = "false") =>
  leaf({
    package: "com.facebook.katana",
    class: "android.widget.Button",
    "content-desc": selected === "true" ? "Unlike" : "Me gusta",
    selected,
    bounds: "[80,900][300,1000]",
  });
const comment = leaf({
  package: "com.facebook.katana",
  class: "android.widget.Button",
  "content-desc": "Comentar",
  bounds: "[360,900][620,1000]",
});

test("binds marker and controls to one post and preserves an existing like", () => {
  const target = locateFacebookTarget(screen(post(marker + like("true") + comment)), markerText);
  assert.equal(target.alreadyLiked, true);
  assert.deepEqual(target.commentBounds, { left: 360, top: 900, right: 620, bottom: 1000 });
});

const markerText = "cosecha de verano sustentable";

test("fails closed for ambiguous controls or different posts", () => {
  assert.throws(
    () => locateFacebookTarget(screen(post(marker + like() + comment + like())), markerText),
    /único contenedor/,
  );
  assert.throws(
    () => locateFacebookTarget(screen(post(marker) + post(like() + comment)), markerText),
    /único contenedor/,
  );
  assert.throws(
    () =>
      locateFacebookTarget(
        screen(
          post(
            leaf({
              package: "com.facebook.katana",
              class: "android.widget.TextView",
              text: "Precosecha de verano sustentable",
              bounds: "[40,300][1040,600]",
            }) +
              like() +
              comment,
          ),
        ),
        markerText,
      ),
    /único contenedor/,
  );
});

test("verifies exact visible comment and empty composer in the same thread", () => {
  const expected = "Este cultivo se ve excelente";
  const composer = leaf({
    package: "com.facebook.katana",
    class: "android.widget.EditText",
    hint: "Escribe un comentario",
    text: "",
    bounds: "[40,1400][1040,1550]",
  });
  const published = leaf({
    package: "com.facebook.katana",
    class: "android.widget.TextView",
    text: expected,
    bounds: "[40,1100][1040,1200]",
  });
  assert.equal(
    verifyFacebookDelivery(
      screen(post(marker + published + composer)),
      markerText,
      { left: 20, top: 200, right: 1060, bottom: 1500 },
      expected,
    ),
    true,
  );
  assert.throws(
    () =>
      verifyFacebookDelivery(
        screen(
          post(marker + published, "[20,200][1060,800]") +
            post(composer, "[20,900][1060,1500]"),
        ),
        markerText,
        { left: 20, top: 200, right: 1060, bottom: 800 },
        expected,
      ),
    /único hilo/,
  );
});
