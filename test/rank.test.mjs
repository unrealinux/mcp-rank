// 综合分公式单测。Run: npm test
// 公式细节见 lib/rank.mjs 与 README「综合分」一节。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bayesRating,
  starScoreOf,
  engagementScoreOf,
  scoreOf,
  STARS_WEIGHT_WITH_REVIEWS,
  STARS_WEIGHT_NO_REVIEWS,
  REVIEW_WEIGHT,
  ENGAGEMENT_WEIGHT,
} from '../lib/rank.mjs';

const closeTo = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≉ ${expected}`);

// ---- 权重和恒为 1 ----------------------------------------------------------
test('有评价时权重和恒为 1', () => {
  closeTo(STARS_WEIGHT_WITH_REVIEWS + REVIEW_WEIGHT + ENGAGEMENT_WEIGHT, 1);
});

test('无评价时权重并到星标，和仍为 1', () => {
  closeTo(STARS_WEIGHT_NO_REVIEWS + ENGAGEMENT_WEIGHT, 1);
});

// ---- 星标分 ---------------------------------------------------------------
test('星标满值时星标分无非评条目拿满 75 分', () => {
  // 星标项 = starsMax → starScore = 1，无评价无互动 → 0.75 × 100
  closeTo(scoreOf({ stars: 100, starsMax: 100, reviews: 0, ratingSum: 0, likes: 0, favorites: 0 }), 75);
});

test('无星标则星标分恒为 0（不因 starsMax=0 退化）', () => {
  closeTo(starScoreOf(0, 100), 0);
  closeTo(starScoreOf(0, 0), 0);
});

test('星标对数归一：10 星、上限 99 星', () => {
  closeTo(starScoreOf(10, 99), Math.log10(11) / Math.log10(100));
});

// ---- 贝叶斯评分 -----------------------------------------------------------
test('1 条 5 星被贝叶斯拉向 3.5，只得 3.75 分基数', () => {
  closeTo(bayesRating(5, 1), (5 + 5 * 3.5) / 6); // = 3.75
});

test('1 条 1 星不被单独放大成极低分', () => {
  closeTo(bayesRating(1, 1), (1 + 5 * 3.5) / 6); // ≈ 3.083，而不是 1
});

test('贝叶斯随评价数增多收敛到真实均值', () => {
  // 100 条评价均值 4.8：先验仍把它拉到 4.738（权重 5/105），但已明显高于先验 3.5
  assert.ok(bayesRating(480, 100) > 4.7);
  assert.ok(bayesRating(480, 100) < 4.8);
  closeTo(bayesRating(480, 100), (480 + 17.5) / 105);
});

test('无评价时评分项整体不参与（无白拿分）', () => {
  // 无评价：0 星标 + 0 互动 → 0 分，而不是 0.3 × (3.5/5) × 100 = 21
  closeTo(scoreOf({ stars: 0, starsMax: 100, reviews: 0, ratingSum: 0, likes: 0, favorites: 0 }), 0);
});

// ---- 互动分（固定分母） ----------------------------------------------------
test('50 次加权互动（点赞 1、收藏 2）拿满互动 25 分', () => {
  closeTo(engagementScoreOf(50, 0), 1);
  closeTo(scoreOf({ stars: 0, starsMax: 100, reviews: 0, ratingSum: 0, likes: 50, favorites: 0 }), 25);
});

test('互动分母固定，不随全场最大值放大', () => {
  // 1 个赞：25 × log10(2)/log10(51) ≈ 4.408，而不是 log10(2)/log10(2) = 25
  closeTo(scoreOf({ stars: 0, starsMax: 100, reviews: 0, ratingSum: 0, likes: 1, favorites: 0 }), 25 * (Math.log10(2) / Math.log10(51)), 1e-6);
});

test('互动超过满值封顶为 1', () => {
  closeTo(engagementScoreOf(1000, 0), 1);
  assert.ok(engagementScoreOf(9999, 9999) <= 1);
});

test('收藏权重是点赞的两倍', () => {
  assert.ok(engagementScoreOf(0, 1) > engagementScoreOf(1, 0)); // 2 互动 > 1 互动
});

// ---- 综合分端到端 ----------------------------------------------------------
test('各项不超各自权重，总分恒 ≤ 100（有评价）', () => {
  // 星标满值 45 + 互动满值 25 + 10 条 5 星评价被先验拉到 4.5 → 27，共 97。
  // 评分项永远到不了满 30（先验不可消去），这正是贝叶斯的设计意图。
  closeTo(scoreOf({ stars: 100, starsMax: 100, reviews: 10, ratingSum: 50, likes: 40, favorites: 5 }), 97);
  for (const input of [
    { stars: 100, starsMax: 100, reviews: 9999, ratingSum: 49995, likes: 0, favorites: 0 },
    { stars: 3, starsMax: 100, reviews: 2, ratingSum: 10, likes: 100, favorites: 500 },
    { stars: 0, starsMax: 100, reviews: 1, ratingSum: 1, likes: 49, favorites: 0 },
  ]) assert.ok(scoreOf(input) <= 100, `score ${input.stars} ≤ 100`);
});

test('README 冒烟：榜一（星标满值）在拿到中性评价池后分数被小幅压缩且 < 75', () => {
  // 1 条 3 星评价：星标 0.45×100 = 45，贝叶斯 = (3 + 17.5)/6 ≈ 3.417 → 20.5
  const got = scoreOf({ stars: 100, starsMax: 100, reviews: 1, ratingSum: 3, likes: 0, favorites: 0 });
  closeTo(got, 45 + 30 * ((3 + 17.5) / 6 / 5));
  assert.ok(got < 75);
});

test('小星标条目获得好评总是净加分', () => {
  // 10 星（上限 99）→ 0.45 × 26.0 ≈ 11.7；5 星评价补 0.3 × (4.5/5) × 100 = 27
  const noRev = scoreOf({ stars: 10, starsMax: 99, reviews: 0, ratingSum: 0, likes: 0, favorites: 0 });
  const withRev = scoreOf({ stars: 10, starsMax: 99, reviews: 1, ratingSum: 5, likes: 0, favorites: 0 });
  assert.ok(withRev > noRev);
});
