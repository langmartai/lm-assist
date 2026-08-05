/**
 * Unit tests for the YouTube connector's pure node-side parsers.
 *
 * This connector reads DATA, not the DOM: it fetches each target URL in-page and
 * parses the JSON YouTube embeds (`ytInitialData`, `ytInitialPlayerResponse`).
 * That parsing is pure and runs in node, so — unlike the DOM-scrape connectors —
 * it is directly unit-testable against fixtures here, with no browser. These
 * fixtures mirror the real shapes (a channel richGrid, a player response with
 * caption tracks, a json3 timedtext payload).
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  parseVideoId,
  collectChannelVideos,
  channelNameFromData,
  firstChannelPathFromSearch,
  pickCaptionTrack,
  playerResponseToInfo,
  parseJson3,
  parseSrv3,
} from '../youtube/cdp-client';

test('parseVideoId extracts the id from every accepted form', () => {
  const cases: Array<[string, string]> = [
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ];
  for (const [input, want] of cases) assert.strictEqual(parseVideoId(input), want, input);
});

test('parseVideoId rejects input with no extractable id', () => {
  for (const bad of ['', 'not a url', 'https://example.com/watch?v=short']) {
    assert.throws(() => parseVideoId(bad), /video id|required/i, bad);
  }
});

// A fixture shaped like a channel /videos ytInitialData (richGrid → richItem →
// videoRenderer), plus channel metadata, plus decoy nodes to prove the deep-scan
// picks videos regardless of nesting and preserves order.
const CHANNEL_DATA = {
  metadata: { channelMetadataRenderer: { title: 'Test Channel' } },
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              richGridRenderer: {
                contents: [
                  { richItemRenderer: { content: { videoRenderer: {
                    videoId: 'aaaaaaaaaaa',
                    title: { runs: [{ text: 'First video' }] },
                    viewCountText: { simpleText: '1.2M views' },
                    publishedTimeText: { simpleText: '2 days ago' },
                    lengthText: { simpleText: '10:11' },
                  } } } },
                  { richItemRenderer: { content: { videoRenderer: {
                    videoId: 'bbbbbbbbbbb',
                    title: { simpleText: 'Second video' },
                    shortViewCountText: { simpleText: '900 views' },
                    publishedTimeText: { simpleText: '1 week ago' },
                    thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { text: { simpleText: '3:04' } } }],
                  } } } },
                  // a duplicate id must be deduped
                  { richItemRenderer: { content: { videoRenderer: {
                    videoId: 'aaaaaaaaaaa',
                    title: { simpleText: 'First video (dupe)' },
                  } } } },
                ],
              },
            },
          },
        },
      ],
    },
  },
};

test('collectChannelVideos parses videos in order, dedupes, and caps at limit', () => {
  const vids = collectChannelVideos(CHANNEL_DATA, 10);
  assert.strictEqual(vids.length, 2, 'two unique videos');
  assert.strictEqual(vids[0].videoId, 'aaaaaaaaaaa');
  assert.strictEqual(vids[0].title, 'First video');
  assert.strictEqual(vids[0].url, 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
  assert.strictEqual(vids[0].views, '1.2M views');
  assert.strictEqual(vids[0].published, '2 days ago');
  assert.strictEqual(vids[0].duration, '10:11');
  assert.strictEqual(vids[1].videoId, 'bbbbbbbbbbb');
  assert.strictEqual(vids[1].duration, '3:04', 'duration from thumbnail overlay');

  assert.strictEqual(collectChannelVideos(CHANNEL_DATA, 1).length, 1, 'limit respected');
});

test('channelNameFromData reads the channel title', () => {
  assert.strictEqual(channelNameFromData(CHANNEL_DATA), 'Test Channel');
  assert.strictEqual(channelNameFromData({}), null);
});

test('firstChannelPathFromSearch returns the first channel canonical path', () => {
  const search = {
    contents: { x: [{ channelRenderer: { navigationEndpoint: { browseEndpoint: { canonicalBaseUrl: '/@SomeChannel' } } } }] },
  };
  assert.strictEqual(firstChannelPathFromSearch(search), '/@SomeChannel');
  assert.strictEqual(firstChannelPathFromSearch({}), null);
});

test('pickCaptionTrack honours language, prefers human over asr, falls back', () => {
  const tracks = [
    { languageCode: 'en', kind: 'asr' },
    { languageCode: 'es' },
    { languageCode: 'en' },
  ];
  assert.strictEqual(pickCaptionTrack(tracks, 'es').languageCode, 'es');
  assert.strictEqual(pickCaptionTrack(tracks, 'en').kind, undefined, 'en human, not asr');
  // no lang → first non-asr (es)
  assert.strictEqual(pickCaptionTrack(tracks).languageCode, 'es');
  // only asr available → returns it
  assert.strictEqual(pickCaptionTrack([{ languageCode: 'en', kind: 'asr' }]).kind, 'asr');
  assert.strictEqual(pickCaptionTrack([]), null);
});

test('playerResponseToInfo normalises a player response', () => {
  const pr = {
    playabilityStatus: { status: 'OK' },
    videoDetails: {
      videoId: 'ccccccccccc',
      title: 'A Talk',
      author: 'Speaker',
      channelId: 'UC123',
      lengthSeconds: '754',
      viewCount: '48213',
      shortDescription: 'hello world',
      keywords: ['a', 'b'],
      isLiveContent: false,
    },
    microformat: { playerMicroformatRenderer: { publishDate: '2026-01-02' } },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', baseUrl: 'x' }] } },
  };
  const info = playerResponseToInfo(pr, 'ccccccccccc');
  assert.strictEqual(info.videoId, 'ccccccccccc');
  assert.strictEqual(info.title, 'A Talk');
  assert.strictEqual(info.channel, 'Speaker');
  assert.strictEqual(info.channelUrl, 'https://www.youtube.com/channel/UC123');
  assert.strictEqual(info.lengthSeconds, 754);
  assert.strictEqual(info.views, 48213);
  assert.strictEqual(info.published, '2026-01-02');
  assert.deepStrictEqual(info.keywords, ['a', 'b']);
  assert.strictEqual(info.hasCaptions, true);
});

// A fixture shaped like the 2026 channel /videos layout (lockupViewModel) —
// captured field-for-field from a live page on 2026-08-05.
const LOCKUP_DATA = {
  contents: {
    grid: [
      {
        richItemRenderer: {
          content: {
            lockupViewModel: {
              contentId: 'ddddddddddd',
              contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
              contentImage: {
                thumbnailViewModel: {
                  overlays: [
                    { thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: '7:08' } }] } },
                  ],
                },
              },
              metadata: {
                lockupMetadataViewModel: {
                  title: { content: 'A lockup-layout video' },
                  metadata: {
                    contentMetadataViewModel: {
                      metadataRows: [
                        { metadataParts: [{ text: { content: 'Some Channel' } }] },
                        { metadataParts: [{ text: { content: '920K views' } }, { text: { content: '6 days ago' } }] },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
      // a non-video lockup (playlist) must be skipped
      {
        richItemRenderer: {
          content: {
            lockupViewModel: {
              contentId: 'PLxxxxxxxxx',
              contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST',
              metadata: { lockupMetadataViewModel: { title: { content: 'A playlist' } } },
            },
          },
        },
      },
    ],
  },
};

test('collectChannelVideos parses the 2026 lockupViewModel layout', () => {
  const vids = collectChannelVideos(LOCKUP_DATA, 10);
  assert.strictEqual(vids.length, 1, 'one video lockup (playlist skipped)');
  assert.strictEqual(vids[0].videoId, 'ddddddddddd');
  assert.strictEqual(vids[0].title, 'A lockup-layout video');
  assert.strictEqual(vids[0].views, '920K views');
  assert.strictEqual(vids[0].published, '6 days ago');
  assert.strictEqual(vids[0].duration, '7:08');
});

test('parseSrv3 parses timedtext XML incl nested spans and entities', () => {
  const xml =
    '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">\n<body>\n' +
    '<p t="4212" d="793">Alright,</p>\n' +
    '<p t="6506" d="1960">Hi YouTube,\nit&#39;s Pabllo &amp; friends</p>\n' +
    '<p t="9000" d="1000"><s>word</s><s> by</s><s> word</s></p>\n' +
    '<p t="12000" d="500">   </p>\n' + // whitespace-only → dropped
    '</body></timedtext>';
  const segs = parseSrv3(xml);
  assert.strictEqual(segs.length, 3);
  assert.deepStrictEqual(segs[0], { start: 4, text: 'Alright,' });
  assert.deepStrictEqual(segs[1], { start: 7, text: "Hi YouTube, it's Pabllo & friends" });
  assert.deepStrictEqual(segs[2], { start: 9, text: 'word by word' });
});

test('parseJson3 flattens timedtext events into segments', () => {
  const payload = {
    events: [
      { tStartMs: 0, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
      { tStartMs: 3200, segs: [{ utf8: '\n' }] }, // whitespace-only → dropped
      { tStartMs: 5000, segs: [{ utf8: 'second line' }] },
      { tStartMs: 9000 }, // no segs → skipped
    ],
  };
  const segs = parseJson3(payload);
  assert.strictEqual(segs.length, 2);
  assert.deepStrictEqual(segs[0], { start: 0, text: 'Hello world' });
  assert.deepStrictEqual(segs[1], { start: 5, text: 'second line' });
});
