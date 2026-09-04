import assert from "node:assert/strict";
import test from "node:test";

import {
  extractFacebookDescriptionFromHierarchy,
  locateFacebookProfileShareConfirmation,
  locateFacebookProfileShareDestination,
  locateFacebookShareTarget,
  locateFacebookTarget,
  runFacebookPost,
  verifyFacebookShareDelivery,
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
const share = leaf({
  package: "com.facebook.katana",
  class: "android.widget.Button",
  "content-desc": "Compartir",
  clickable: "true",
  bounds: "[700,900][1020,1000]",
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

test("requires the profile-specific Facebook share destination and confirmation", () => {
  const target = locateFacebookShareTarget(
    screen(post(marker + like() + comment + share)),
    markerText,
  );
  assert.deepEqual(target.shareBounds, { left: 700, top: 900, right: 1020, bottom: 1000 });

  assert.deepEqual(
    locateFacebookProfileShareDestination(
      screen(
        leaf({
          package: "com.facebook.katana",
          class: "android.widget.Button",
          "content-desc": "Compartir en tu perfil",
          clickable: "true",
          bounds: "[80,1200][1000,1300]",
        }),
      ),
    ),
    { left: 80, top: 1200, right: 1000, bottom: 1300 },
  );

  assert.deepEqual(
    locateFacebookProfileShareConfirmation(
      screen(
        node(
          {
            package: "com.facebook.katana",
            class: "android.view.ViewGroup",
            bounds: "[0,1100][1080,1600]",
          },
          leaf({
            package: "com.facebook.katana",
            class: "android.widget.TextView",
            text: "Tu perfil",
            bounds: "[80,1160][1000,1220]",
          }) +
            leaf({
              package: "com.facebook.katana",
              class: "android.widget.Button",
              "content-desc": "Compartir ahora",
              clickable: "true",
              bounds: "[80,1400][1000,1510]",
            }),
        ),
      ),
    ),
    { left: 80, top: 1400, right: 1000, bottom: 1510 },
  );
  assert.equal(
    verifyFacebookShareDelivery(
      screen(
        leaf({
          package: "com.facebook.katana",
          class: "android.view.ViewGroup",
          "content-desc": "Publicación compartida",
          bounds: "[80,100][1000,180]",
        }),
      ),
    ),
    true,
  );
  assert.throws(
    () =>
      locateFacebookProfileShareDestination(
        screen(
          leaf({
            package: "com.facebook.katana",
            class: "android.widget.Button",
            "content-desc": "Enviar por Messenger",
            clickable: "true",
            bounds: "[80,1200][1000,1300]",
          }),
        ),
      ),
    /Compartir en tu perfil/,
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
      likeStateObservable: true,
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
      likeStateObservable: true,
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

test("binds right-rail Reel controls only to its marked video surface", () => {
  const description = "Cultivo responsable y trabajo comunitario";
  const reelSurface = post(
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      "content-desc": "Detalles del reel",
      bounds: "[0,0][1080,1920]",
    }) +
      leaf({
        package: "com.facebook.katana",
        class: "android.widget.TextView",
        text: description,
        bounds: "[40,1240][820,1360]",
      }),
    "[0,0][1080,1920]",
  );
  const rightRailLike = leaf({
    package: "com.facebook.katana",
    class: "android.widget.Button",
    "content-desc": "70 reacciones",
    clickable: "true",
    bounds: "[954,1394][1080,1499]",
  }) +
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.Button",
    "content-desc": "70 reacciones",
    clickable: "true",
    bounds: "[954,1491][1080,1557]",
    "long-clickable": "true",
    });
  const rightRailComment = leaf({
    package: "com.facebook.katana",
    class: "android.widget.Button",
    "content-desc": "25 comentarios",
    clickable: "true",
    bounds: "[954,1557][1080,1728]",
  });
  const reelScreen = screen(reelSurface + rightRailLike + rightRailComment);

  assert.deepEqual(
    locateFacebookTarget(reelScreen, "cultivo responsable trabajo comunitario"),
    {
      containerBounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
      likeBounds: { left: 954, top: 1491, right: 1080, bottom: 1557 },
      commentBounds: { left: 954, top: 1557, right: 1080, bottom: 1728 },
      likeStateObservable: false,
      alreadyLiked: false,
    },
  );
  assert.deepEqual(
    locateFacebookTarget(
      reelScreen
        .replaceAll("70 reacciones", "1 reacción")
        .replace(
          'clickable="true" bounds="[954,1394][1080,1499]"',
          'clickable="true" selected="true" bounds="[954,1394][1080,1499]"',
        ),
      "cultivo responsable trabajo comunitario",
    ),
    {
      containerBounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
      likeBounds: { left: 954, top: 1394, right: 1080, bottom: 1499 },
      commentBounds: { left: 954, top: 1557, right: 1080, bottom: 1728 },
      likeStateObservable: false,
      alreadyLiked: true,
    },
  );
  assert.deepEqual(
    locateFacebookTarget(
      screen(
        reelSurface +
          leaf({
            package: "com.facebook.katana",
            class: "android.widget.Button",
            "content-desc":
              "Botón &quot;Me gusta&quot;. Toca dos veces y mantén presionado para reaccionar.",
            clickable: "true",
            bounds: "[954,1584][1080,1689]",
          }) +
          rightRailComment +
          leaf({
            package: "com.facebook.katana",
            class: "android.widget.Button",
            text: "Agregar un comentario",
            "content-desc": "Agregar un comentario",
            clickable: "true",
            bounds: "[0,1920][1080,2078]",
          }),
      ),
      "cultivo responsable trabajo comunitario",
    ),
    {
      containerBounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
      likeBounds: { left: 954, top: 1584, right: 1080, bottom: 1689 },
      commentBounds: { left: 954, top: 1557, right: 1080, bottom: 1728 },
      likeStateObservable: true,
      alreadyLiked: false,
    },
  );
  assert.throws(
    () =>
      locateFacebookTarget(
        reelScreen.replace('long-clickable="true"', 'long-clickable="false"'),
        "cultivo responsable trabajo comunitario",
      ),
    /único contenedor/,
  );
  assert.throws(
    () =>
      locateFacebookTarget(
        reelScreen.replace(
          rightRailLike,
          rightRailLike +
            leaf({
              package: "com.facebook.katana",
              class: "android.widget.Button",
              "content-desc": "15 reacciones",
              clickable: "true",
              bounds: "[954,1220][1080,1310]",
              "long-clickable": "true",
            }),
        ),
        "cultivo responsable trabajo comunitario",
      ),
    /único contenedor/,
  );
});

test("continues to the comment after an unambiguous Reel reaction with no accessible state", async () => {
  const description = "Cultivo responsable y trabajo comunitario";
  const expectedComment = "mejor seria un fondo concursable para proyectos";
  const reel = (commentSurface = "") =>
    post(
      leaf({
        package: "com.facebook.katana",
        class: "android.widget.Button",
        "content-desc": "Detalles del reel",
        bounds: "[0,0][1080,1920]",
      }) +
        leaf({
          package: "com.facebook.katana",
          class: "android.widget.TextView",
          text: description,
          bounds: "[40,1240][820,1360]",
        }) +
        commentSurface,
      "[0,0][1080,1920]",
    );
  const controls =
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      "content-desc": "71 reacciones",
      clickable: "true",
      bounds: "[954,1394][1080,1499]",
    }) +
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      "content-desc": "71 reacciones",
      clickable: "true",
      "long-clickable": "true",
      bounds: "[954,1491][1080,1557]",
    }) +
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      "content-desc": "25 comentarios",
      clickable: "true",
      bounds: "[954,1557][1080,1728]",
    });
  const composer = (text: string) =>
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.EditText",
      hint: "Escribe un comentario",
      text,
      bounds: "[40,1740][820,1840]",
    }) +
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      "content-desc": "Enviar comentario",
      clickable: "true",
      bounds: "[840,1740][1040,1840]",
    });
  const initial = screen(reel() + controls);
  const thread = screen(reel(composer("")) + controls);
  const ready = screen(reel(composer(expectedComment)) + controls);
  const delivered = screen(
    reel(
      leaf({
        package: "com.facebook.katana",
        class: "android.widget.TextView",
        text: expectedComment,
        bounds: "[40,1600][820,1700]",
      }) + composer(""),
    ) + controls,
  );
  let phase = 0;
  const checkpoints: string[] = [];
  const driver = {
    getCurrentPackage: async () => "com.facebook.katana",
    getPageSource: async () =>
      phase < 2 ? initial : phase === 2 ? thread : phase === 3 ? ready : delivered,
    execute: async (command: string, args: Record<string, unknown>) => {
      if (command === "mobile: type") phase = 3;
      if (command !== "mobile: clickGesture") return;
      const y = args.y as number;
      if (y > 1450 && y < 1600) phase = 1;
      else if (y > 1600 && y < 1750) phase = 2;
      else phase = 4;
    },
    $: async () => ({ clearValue: async () => {}, click: async () => {} }),
  };

  await runFacebookPost(
    driver as never,
    {
      url: "https://www.facebook.com/reel/1047727811376295",
      commentText: expectedComment,
      targetMarker: "cultivo responsable trabajo comunitario",
    },
    new AbortController().signal,
    (checkpoint) => checkpoints.push(checkpoint),
    async () => {},
  );

  assert.deepEqual(checkpoints, ["like", "comment"]);
});

test("activates a Reel composer that Facebook initially hides from accessibility", async () => {
  const description = "Cultivo responsable y trabajo comunitario";
  const expectedComment = "mejor seria un fondo concursable para proyectos";
  const initial = screen(
    post(
      leaf({
        package: "com.facebook.katana",
        class: "android.widget.Button",
        "content-desc": "Detalles del reel",
        bounds: "[0,0][1080,1920]",
      }) +
        leaf({
          package: "com.facebook.katana",
          class: "android.widget.TextView",
          text: description,
          bounds: "[40,1240][820,1360]",
        }),
      "[0,0][1080,1920]",
    ) +
      leaf({
        package: "com.facebook.katana",
        class: "android.widget.Button",
        "content-desc": "1 reacción",
        selected: "true",
        clickable: "true",
        bounds: "[954,1394][1080,1499]",
      }) +
      leaf({
        package: "com.facebook.katana",
        class: "android.widget.Button",
        "content-desc": "1 reacción",
        clickable: "true",
        "long-clickable": "true",
        bounds: "[954,1491][1080,1557]",
      }) +
      leaf({
        package: "com.facebook.katana",
        class: "android.widget.Button",
        "content-desc": "0 comentarios",
        clickable: "true",
        bounds: "[954,1557][1080,1728]",
      }),
  );
  const sheet = (children: string) =>
    `<hierarchy>${node(
      {
        package: "com.facebook.katana",
        class: "android.widget.FrameLayout",
        bounds: "[0,557][1080,2280]",
      },
      leaf({
        package: "com.facebook.katana",
        class: "android.view.ViewGroup",
        text: "Aún no hay comentarios",
        "content-desc": "Aún no hay comentarios",
        bounds: "[0,558][1080,1323]",
      }) + children,
    )}</hierarchy>`;
  const hiddenComposer = sheet(
    leaf({
      package: "com.facebook.katana",
      class: "android.view.ViewGroup",
      text: "Comentarios sugeridos",
      "content-desc": "Comentarios sugeridos",
      bounds: "[0,1689][1080,2154]",
    }),
  );
  const ready = sheet(
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.EditText",
      text: expectedComment,
      focusable: "true",
      focused: "true",
      bounds: "[32,1825][1048,1924]",
    }) +
      leaf({
        package: "com.facebook.katana",
        class: "android.widget.Button",
        "content-desc": "Enviar",
        clickable: "true",
        bounds: "[964,1929][1069,2034]",
      }),
  );
  const delivered = sheet(
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.TextView",
      text: expectedComment,
      bounds: "[40,1200][900,1300]",
    }),
  );
  let phase = 0;
  const checkpoints: string[] = [];
  const driver = {
    getCurrentPackage: async () => "com.facebook.katana",
    getPageSource: async () =>
      phase < 1 ? initial : phase < 3 ? hiddenComposer : phase === 3 ? ready : delivered,
    execute: async (command: string, args: Record<string, unknown>) => {
      if (command === "mobile: type") {
        phase = 3;
        return;
      }
      if (command !== "mobile: clickGesture") return;
      const y = args.y as number;
      if (y > 1550 && y < 1800) phase = 1;
      else if (y > 1900) phase = phase === 3 ? 4 : 2;
    },
    $: async () => ({ clearValue: async () => {}, click: async () => {} }),
  };

  await runFacebookPost(
    driver as never,
    {
      url: "https://www.facebook.com/reel/1047727811376295",
      commentText: expectedComment,
      targetMarker: "cultivo responsable trabajo comunitario",
    },
    new AbortController().signal,
    (checkpoint) => checkpoints.push(checkpoint),
    async () => {},
  );

  assert.deepEqual(checkpoints, ["comment"]);
  assert.equal(phase, 4);
});

test("scrolls a uniquely marked normal post just enough to expose its actions", async () => {
  const expectedComment = "comentario despues del desplazamiento seguro";
  const hidePost = leaf({
    package: "com.facebook.katana",
    class: "android.widget.Button",
    "content-desc": "Ocultar publicación",
    clickable: "true",
    bounds: "[900,220][1040,300]",
  });
  const initial = screen(
    post(
      marker +
        hidePost +
        leaf({
          package: "com.facebook.katana",
          class: "android.widget.Button",
          "content-desc": "Foto 3 de 3, expandir foto",
          bounds: "[545,900][1060,1500]",
        }),
    ),
  );
  const target = screen(post(marker + hidePost + like("true") + comment));
  const composer = (text: string) =>
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.EditText",
      text,
      hint: "Comentar…",
      focusable: "true",
      bounds: "[32,1500][900,1600]",
    }) +
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.Button",
      "content-desc": "Enviar",
      clickable: "true",
      bounds: "[920,1500][1040,1600]",
    });
  const modal = (children: string) =>
    `<hierarchy>${node(
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
      }) + children,
    )}</hierarchy>`;
  const thread = modal(composer(""));
  const ready = modal(composer(expectedComment));
  const delivered = modal(
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.TextView",
      text: expectedComment,
      bounds: "[40,500][900,600]",
    }) + composer(""),
  );
  let phase = 0;
  let orientation = "";
  let swipeSpeed = 0;
  const checkpoints: string[] = [];
  const driver = {
    setOrientation: async (value: string) => {
      orientation = value;
    },
    getCurrentPackage: async () => "com.facebook.katana",
    getPageSource: async () =>
      phase === 0 ? initial : phase === 1 ? target : phase === 2 ? thread : phase === 3 ? ready : delivered,
    execute: async (command: string, args: Record<string, unknown>) => {
      if (command === "mobile: swipeGesture") {
        swipeSpeed = args.speed as number;
        phase = 1;
      }
      else if (command === "mobile: type") phase = 3;
      else if (command === "mobile: clickGesture") phase = phase === 1 ? 2 : 4;
    },
    $: async () => ({ clearValue: async () => {}, click: async () => {} }),
  };

  await runFacebookPost(
    driver as never,
    {
      url: "https://www.facebook.com/share/p/example",
      commentText: expectedComment,
      targetMarker: markerText,
    },
    new AbortController().signal,
    (checkpoint) => checkpoints.push(checkpoint),
    async () => {},
  );

  assert.deepEqual(checkpoints, ["comment"]);
  assert.equal(orientation, "PORTRAIT");
  assert.equal(swipeSpeed, 600);
  assert.equal(phase, 4);
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

test("matches a marker split across Facebook text nodes in a full-screen post", () => {
  const splitMarker = "cultivo sostenible para toda la comunidad";
  const fullScreenPost = post(
    leaf({
      package: "com.facebook.katana",
      class: "android.widget.TextView",
      text: "Cultivo sostenible para",
      bounds: "[40,300][1040,450]",
    }) +
      leaf({
        package: "com.facebook.katana",
        class: "android.widget.TextView",
        text: "toda la comunidad",
        bounds: "[40,450][1040,600]",
      }) +
      like() +
      comment,
    "[0,0][1080,1920]",
  );

  assert.deepEqual(locateFacebookTarget(screen(fullScreenPost), splitMarker), {
    containerBounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
    likeBounds: { left: 80, top: 900, right: 300, bottom: 1000 },
    commentBounds: { left: 360, top: 900, right: 620, bottom: 1000 },
    likeStateObservable: true,
    alreadyLiked: false,
  });
});

test("matches a legacy marker in a Facebook full-screen viewer", () => {
  const viewerLike = leaf({
    package: "com.facebook.katana",
    class: "android.widget.Button",
    "content-desc":
      "Botón &quot;Me gusta&quot;. Toca dos veces y mantén presionado para reaccionar al comentario.",
    clickable: "true",
    bounds: "[36,1944][216,2076]",
  });
  const viewerComment = leaf({
    package: "com.facebook.katana",
    class: "android.widget.Button",
    "content-desc": "Comentar",
    clickable: "true",
    bounds: "[216,1944][410,2076]",
  });
  const viewer = `<hierarchy>${node(
    {
      package: "com.facebook.katana",
      class: "android.widget.FrameLayout",
      bounds: "[0,0][1080,2076]",
    },
    node(
      {
        package: "com.facebook.katana",
        class: "android.widget.FrameLayout",
        bounds: "[0,1219][1080,2076]",
      },
      post(
        leaf({
          package: "com.facebook.katana",
          class: "android.widget.TextView",
          text: "Un saludo a toda la clase obrera",
          bounds: "[40,1711][1040,1944]",
        }) +
          viewerLike +
          viewerComment,
        "[0,1219][1080,2076]",
      ),
    ),
  )}</hierarchy>`;

  assert.deepEqual(
    locateFacebookTarget(viewer, "un saludo toda la clase obrera"),
    {
      containerBounds: { left: 0, top: 1219, right: 1080, bottom: 2076 },
      likeBounds: { left: 36, top: 1944, right: 216, bottom: 2076 },
      commentBounds: { left: 216, top: 1944, right: 410, bottom: 2076 },
      likeStateObservable: true,
      alreadyLiked: false,
    },
  );
  assert.throws(
    () => locateFacebookTarget(viewer, "un saludo para toda la clase obrera"),
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
