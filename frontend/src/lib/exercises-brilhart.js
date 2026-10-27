// © Brilhart Fitness exercise data — the 4 "port de bras" exercises with Brilhart's own media
// (ISO-1605, epic ISO-1601). Deliberately kept out of exercises-data.js (EXDB): EXDB is the
// MIT-licensed, auto-generated dataset and the sibling issue that strips its third-party img/gif
// fields (ISO-1603) rewrites that file; a Brilhart entry living inside it would conflict with
// that work and blur a © Brilhart asset into a MIT-licensed one. exercises.js folds this list
// into CATALOGUE/EXIDX instead, so every lookup, search and filter already in the app sees these
// four exercises without knowing they came from a different source.
//
// Ids: 'bf' + 2 digits. EXDB ids are 4-digit numbers and a user's own custom exercises are
// 'c' + a uid (registerCustom in exercises.js) — neither pattern can ever produce 'bf01'..'bf04',
// which exercises-brilhart.test.js asserts against the whole catalogue.
//
// Media: only the front view exists today. The Drive folder the issue pointed at
// (id 1wzrnPnAePwOyYS9VMxqHcawM9o_k3Gdc, "Brilhart Fit" → gif/) holds exactly one file,
// Gifs_braços_frente.zip, with the 4 front GIFs this module uses — no back/"costas" folder, zip
// or loose file exists there (checked 2026-10-25; see the ISO-1605 delivery comment). Shipping
// front-only is the safe default: the view-switcher UI is a separate issue (ISO-1606) that
// doesn't exist yet, so only the top-level img/gif below render anywhere today, and a `views`
// entry is trivial to append once Brilhart uploads the back-view GIFs. `src: 'brilhart'` tells
// imgSrc/gifSrc (exercises.js) to resolve these through the app's own bundled
// frontend/public/brilhart/ instead of the CDN-swappable IMG_BASE/GIF_BASE path the EXDB media
// used — these four ship inside the app itself and need no network fetch, including offline in
// the Android/iOS build.
//
// Instructions are pt-BR only, directly in `st`, and `draft: true`: the Drive package was GIFs
// with no accompanying text, so the steps below were written from the GIFs for this delivery and
// still need the Brilhart professora's sign-off (ISO-1605 pastes them into the delivery comment
// for that). `instrFor()` (i18n-core.js) falls back to `st` for every language when the current
// locale's instruction pack has no entry for an id. pt-BR's own pack
// (frontend/src/instr/pt-BR.js) is asserted 1:1 against EXDB by pt-br-instructions.test.js, so
// these four ids can never be added there — `st` is the only place this text can live until a
// real translation pass gives each language its own words, which is also why every locale shows
// the same Portuguese text for now rather than nothing in English and Portuguese only in pt-BR.
// The display name works the same way: `n` is the Portuguese title (not the English one every
// other catalogue entry carries), because there is no pt-BR entry in
// frontend/src/exercise-names/pt-BR.js either (same 1:1 lock, pt-br-exercise-names.test.js) to
// translate an English `n` into for the Portuguese-speaking userbase this content is actually
// for. `nEn` is kept alongside purely as the catalogue-English label for documentation/future
// localization — exerciseNameFor() never reads it.

const BRILHART_MEDIA = {
  bf01: { front: { gif: 'bf01-front.gif', img: 'bf01-front.webp' } },
  bf02: { front: { gif: 'bf02-front.gif', img: 'bf02-front.webp' } },
  bf03: { front: { gif: 'bf03-front.gif', img: 'bf03-front.webp' } },
  bf04: { front: { gif: 'bf04-front.gif', img: 'bf04-front.webp' } },
}

const viewsFor = id => Object.entries(BRILHART_MEDIA[id]).map(([key, media]) => ({ key, ...media }))

export const EXBRILHART = [
  {
    id: 'bf01',
    n: 'Port de bras: preparatória → quinta posição',
    nEn: 'Port de bras: preparatory to fifth position',
    bp: 'shoulders', eq: 'body weight', tg: 'delts', mg: 'trapezius', sm: ['trapezius', 'rhomboids'],
    st: [
      'Fique em pé com a coluna alongada e os braços arredondados à frente do quadril, na posição preparatória.',
      'Inspire e eleve os braços lateralmente, passando pela segunda posição, com os cotovelos levemente flexionados.',
      'Continue elevando os braços acima da cabeça até a quinta posição, com as pontas dos dedos quase se tocando.',
      'Mantenha os ombros relaxados e afastados das orelhas durante toda a elevação.',
      'Pause um instante na quinta posição, sentindo o alongamento lateral do tronco.',
      'Expire e retorne lentamente os braços à posição preparatória, controlando a descida.',
    ],
    draft: true,
    src: 'brilhart',
    views: viewsFor('bf01'),
    img: BRILHART_MEDIA.bf01.front.img,
    gif: BRILHART_MEDIA.bf01.front.gif,
  },
  {
    id: 'bf02',
    n: 'Port de bras: preparatória → segunda posição',
    nEn: 'Port de bras: preparatory to second position',
    bp: 'shoulders', eq: 'body weight', tg: 'delts', mg: 'trapezius', sm: ['trapezius', 'rhomboids'],
    st: [
      'Fique em pé com a coluna alongada e os braços arredondados à frente do quadril, na posição preparatória.',
      'Inspire e abra os braços lateralmente até a altura dos ombros, chegando à segunda posição.',
      'Mantenha os cotovelos levemente mais altos que os pulsos e os dedos suavemente curvados.',
      'Sustente a posição com os ombros baixos e as omoplatas estabilizadas.',
      'Expire e retorne os braços à posição preparatória, controlando o movimento.',
    ],
    draft: true,
    src: 'brilhart',
    views: viewsFor('bf02'),
    img: BRILHART_MEDIA.bf02.front.img,
    gif: BRILHART_MEDIA.bf02.front.gif,
  },
  {
    id: 'bf03',
    n: 'Port de bras: segunda → quinta posição',
    nEn: 'Port de bras: second to fifth position',
    bp: 'shoulders', eq: 'body weight', tg: 'delts', mg: 'trapezius', sm: ['trapezius', 'rhomboids'],
    st: [
      'Fique em pé com os braços abertos lateralmente na segunda posição, na altura dos ombros.',
      'Inspire e eleve os braços em arco por cima da cabeça até a quinta posição.',
      'Aproxime as pontas dos dedos sem encostar, mantendo os cotovelos arredondados.',
      'Mantenha os ombros baixos e relaxados durante toda a elevação.',
      'Expire e retorne os braços à segunda posição, descendo pelo mesmo arco.',
    ],
    draft: true,
    src: 'brilhart',
    views: viewsFor('bf03'),
    img: BRILHART_MEDIA.bf03.front.img,
    gif: BRILHART_MEDIA.bf03.front.gif,
  },
  {
    id: 'bf04',
    n: 'Port de bras circular',
    nEn: 'Port de bras: circular (en rond)',
    bp: 'shoulders', eq: 'body weight', tg: 'delts', mg: 'trapezius', sm: ['trapezius', 'rhomboids'],
    st: [
      'Fique em pé com os braços na posição preparatória, à frente do quadril.',
      'Inicie um movimento circular contínuo, levando os braços pela segunda posição.',
      'Continue o círculo elevando os braços até a quinta posição, acima da cabeça.',
      'Complete o círculo trazendo os braços de volta pela segunda posição até a preparatória.',
      'Mantenha o movimento fluido e contínuo, sem pausas bruscas entre as posições.',
      'Repita o círculo completo pelo número desejado de repetições.',
    ],
    draft: true,
    src: 'brilhart',
    views: viewsFor('bf04'),
    img: BRILHART_MEDIA.bf04.front.img,
    gif: BRILHART_MEDIA.bf04.front.gif,
  },
]
