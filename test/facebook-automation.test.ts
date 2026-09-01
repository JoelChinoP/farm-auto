import assert from "node:assert/strict";
import test from "node:test";

import {
  extractFacebookDescriptionFromHierarchy,
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

test("extracts the visible Facebook description without action controls", () => {
  assert.equal(
    extractFacebookDescriptionFromHierarchy(
      screen(
        post(
          leaf({
            package: "com.facebook.katana",
            class: "android.widget.TextView",
            text: "Cosecha &amp; verano sustentable para toda la comunidad",
            bounds: "[40,300][1040,600]",
          }) +
            like() +
            comment,
        ),
      ),
    ),
    "Cosecha & verano sustentable para toda la comunidad",
  );
  assert.equal(
    extractFacebookDescriptionFromHierarchy(
      screen(
        post(
          leaf({
            package: "com.facebook.katana",
            class: "android.widget.TextView",
            "content-desc": "Descripción disponible por accesibilidad",
            bounds: "[40,300][1040,600]",
          }) +
            like() +
            comment,
        ),
      ),
    ),
    "Descripción disponible por accesibilidad",
  );

  const collapsed =
    "¿De verdad usar inteligencia artificial para hacer trabajos universitarios es “hacer trampa”? 🤔… más";
  assert.throws(
    () =>
      extractFacebookDescriptionFromHierarchy(
        screen(
          post(
            node(
              {
                package: "com.facebook.katana",
                class: "android.view.ViewGroup",
                text: collapsed,
                "content-desc": collapsed,
                clickable: "true",
                bounds: "[40,300][1040,600]",
              },
              leaf({
                package: "com.facebook.katana",
                class: "android.widget.Button",
                text: "más",
                clickable: "true",
                bounds: "[850,520][1040,600]",
              }),
            ) +
              like() +
              comment,
          ),
        ),
      ),
    /contenido completo/,
  );

  assert.throws(
    () =>
      extractFacebookDescriptionFromHierarchy(
        screen(
          leaf({
            package: "com.facebook.katana",
            class: "android.view.ViewGroup",
            "content-desc": "Historias",
            bounds: "[0,0][1080,200]",
          }) +
            leaf({
              package: "com.facebook.katana",
              class: "android.widget.Button",
              "content-desc": "Crear historia",
              bounds: "[20,20][200,180]",
            }) +
            post(marker + like() + comment),
        ),
      ),
    /abrió Inicio/,
  );
});

test("supports duplicated labels and a fixed Facebook comment composer", () => {
  const description =
    "¿De verdad usar inteligencia artificial para hacer trabajos universitarios es hacer trampa?";
  const commentText = "Comentario controlado de verificación";
  const duplicatedLike = leaf({
    package: "com.facebook.katana",
    class: "android.widget.Button",
    text: "Botón &quot;Me gusta&quot;. Toca dos veces para reaccionar.",
    "content-desc": "Botón &quot;Me gusta&quot;. Toca dos veces para reaccionar.",
    clickable: "true",
    selected: "false",
    bounds: "[0,1172][360,1298]",
  });
  const duplicatedComment = leaf({
    package: "com.facebook.katana",
    class: "android.widget.Button",
    text: "Comentar",
    "content-desc": "Comentar",
    clickable: "true",
    bounds: "[360,1172][720,1298]",
  });
  const published = leaf({
    package: "com.facebook.katana",
    class: "android.widget.TextView",
    text: commentText,
    bounds: "[40,1050][800,1120]",
  });
  const detailPost = post(
    leaf({
      package: "com.facebook.katana",
      class: "android.view.ViewGroup",
      text: description,
      "content-desc": description,
      clickable: "true",
      bounds: "[0,415][1080,1050]",
    }) + published + duplicatedLike + duplicatedComment,
    "[0,205][1080,1298]",
  );
  const fixedComposer = node(
    {
      package: "com.facebook.katana",
      class: "android.widget.LinearLayout",
      bounds: "[0,1626][1080,1775]",
    },
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.EditText",
      text: "",
      hint: "Comentar…",
      focusable: "true",
      bounds: "[36,1644][1044,1757]",
    }),
  );
  const detailScreen = `<hierarchy>${node(
    {
      package: "com.facebook.katana",
      class: "androidx.recyclerview.widget.RecyclerView",
      scrollable: "false",
      bounds: "[0,204][1080,1625]",
    },
    detailPost,
  )}${fixedComposer}</hierarchy>`;

  assert.equal(
    extractFacebookDescriptionFromHierarchy(detailScreen),
    description,
  );
  assert.deepEqual(
    locateFacebookTarget(detailScreen, "de verdad usar inteligencia artificial"),
    {
      containerBounds: { left: 0, top: 205, right: 1080, bottom: 1298 },
      likeBounds: { left: 0, top: 1172, right: 360, bottom: 1298 },
      commentBounds: { left: 360, top: 1172, right: 720, bottom: 1298 },
      alreadyLiked: false,
    },
  );
  assert.equal(
    locateFacebookTarget(
      detailScreen.replaceAll(
        "Botón &quot;Me gusta&quot;. Toca dos veces para reaccionar.",
        "Botón &quot;Me gusta&quot; presionado. Toca dos veces y mantén presionado para cambiar la reacción.",
      ),
      "de verdad usar inteligencia artificial",
    ).alreadyLiked,
    true,
  );
  assert.equal(
    verifyFacebookDelivery(
      detailScreen,
      "de verdad usar inteligencia artificial",
      { left: 0, top: 205, right: 1080, bottom: 1298 },
      commentText,
    ),
    true,
  );

  const modalComposer = leaf({
    package: "com.facebook.katana",
    class: "android.widget.EditText",
    text: "",
    hint: "Comentar…",
    focusable: "true",
    bounds: "[36,1400][1044,1513]",
  });
  const commentModal = `<hierarchy>${node(
    {
      package: "com.facebook.katana",
      class: "android.widget.FrameLayout",
      bounds: "[0,0][1080,1776]",
    },
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      "content-desc": "Cerrar",
      clickable: "true",
      bounds: "[480,72][600,108]",
    }) +
      node(
        {
          package: "com.facebook.katana",
          class: "androidx.recyclerview.widget.RecyclerView",
          bounds: "[0,217][1080,1238]",
        },
        published,
      ) +
      node(
        {
          package: "com.facebook.katana",
          class: "android.widget.LinearLayout",
          bounds: "[0,1239][1080,1651]",
        },
        modalComposer,
      ),
  )}</hierarchy>`;
  assert.equal(
    verifyFacebookDelivery(
      commentModal,
      "de verdad usar inteligencia artificial",
      { left: 0, top: 205, right: 1080, bottom: 1298 },
      commentText,
    ),
    true,
  );
  assert.throws(
    () =>
      verifyFacebookDelivery(
        commentModal.replace('content-desc="Cerrar"', 'content-desc="Atrás"'),
        "de verdad usar inteligencia artificial",
        { left: 0, top: 205, right: 1080, bottom: 1298 },
        commentText,
      ),
    /único hilo/,
  );
});

test("extracts a Reel description and ignores its non-actionable comment wrapper", () => {
  const description = "Compromiso con una campaña de respeto, propuestas y transparencia";
  const reel = post(
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      "content-desc": "Detalles del reel",
      bounds: "[20,200][1060,1500]",
    }) +
      like()
        .replace('content-desc="Me gusta"', 'content-desc="Botón Me gusta. Toca para reaccionar al comentario"')
        .replace('selected="false"', 'selected="false" clickable="true"') +
      node(
        {
          package: "com.facebook.katana",
          class: "android.widget.Button",
          "content-desc": "Comentar",
          clickable: "false",
          bounds: "[360,900][620,1100]",
        },
        leaf({
          package: "com.facebook.katana",
          class: "android.widget.Button",
          "content-desc": "Comentar",
          clickable: "true",
          bounds: "[360,900][620,1000]",
        }) +
          leaf({
            package: "com.facebook.katana",
            class: "android.widget.Button",
            "content-desc": "46 comentarios",
            clickable: "true",
            bounds: "[360,1000][620,1050]",
          }),
      ),
  ).replace('class="android.view.ViewGroup"', `class="android.view.ViewGroup" content-desc="${description}"`);
  assert.equal(
    extractFacebookDescriptionFromHierarchy(screen(reel)),
    description,
  );
  assert.deepEqual(
    locateFacebookTarget(screen(reel), "compromiso con una campana"),
    {
      containerBounds: { left: 20, top: 200, right: 1060, bottom: 1500 },
      likeBounds: { left: 80, top: 900, right: 300, bottom: 1000 },
      commentBounds: { left: 360, top: 900, right: 620, bottom: 1000 },
      alreadyLiked: false,
    },
  );
  const videoWithoutControls = post(
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      "content-desc": "Detalles del video",
      bounds: "[20,200][1060,1500]",
    }),
  ).replace('class="android.view.ViewGroup"', `class="android.view.ViewGroup" content-desc="${description}"`);
  assert.equal(
    extractFacebookDescriptionFromHierarchy(screen(videoWithoutControls)),
    description,
  );

  const quotedDescription = '"Simplemente el mejor personaje de toda la serie"';
  for (const tab of ["Reels", "Video"]) {
    const tabDetails = post(
      leaf({
        package: "com.facebook.katana",
        class: "android.widget.Button",
        "content-desc": `Detalles de la pestaña &quot;${tab}&quot;`,
        bounds: "[20,200][1060,1500]",
      }),
    ).replace(
      'class="android.view.ViewGroup"',
      'class="android.view.ViewGroup" content-desc="&quot;Simplemente el mejor personaje de toda la serie&quot;"',
    );
    assert.equal(
      extractFacebookDescriptionFromHierarchy(screen(tabDetails)),
      quotedDescription,
    );
  }
});

test("fails closed for ambiguous posts or a Facebook login screen", () => {
  const secondPost = post(
    marker.replaceAll("[40,300][1040,600]", "[40,1610][1040,1910]") +
      like().replaceAll("[80,900][300,1000]", "[80,2210][300,2310]") +
      comment.replaceAll("[360,900][620,1000]", "[360,2210][620,2310]"),
    "[20,1510][1060,2810]",
  );
  assert.throws(
    () =>
      extractFacebookDescriptionFromHierarchy(
        screen(post(marker + like() + comment) + secondPost),
      ),
    /única publicación/,
  );
  assert.throws(
    () =>
      extractFacebookDescriptionFromHierarchy(
        screen(
          leaf({
            package: "com.facebook.katana",
            class: "android.widget.TextView",
            text: "Inicia sesión en Facebook",
            bounds: "[40,300][1040,600]",
          }),
        ),
      ),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "FACEBOOK_LOGIN_REQUIRED",
      ),
  );
});

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
