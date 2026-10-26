// 综合分公式（README「综合分」一节）。从 server.mjs 抽成纯函数，node:test 可以直接打单测。
// 权重和恒为 1，综合分上限 100；没有评价时评分项的 30% 并到星标（0.75），避免
// 13k 条无评价条目人人白拿 21 分、名次差距被压扁。

export const RATING_PRIOR_WEIGHT = 5; // 虚拟评价条数，把少量评价拉回先验均值
export const RATING_PRIOR_VALUE = 3.5;
export const ENGAGEMENT_FULL = 50; // 50 次加权互动（点赞 1、收藏 2）拿满互动分
export const STARS_WEIGHT_WITH_REVIEWS = 0.45;
export const STARS_WEIGHT_NO_REVIEWS = 0.75;
export const REVIEW_WEIGHT = 0.3;
export const ENGAGEMENT_WEIGHT = 0.25;

// 贝叶斯评分：(总星 + 5 × 3.5) / (评价数 + 5)，5 条以内的评价会被拉向 3.5。
export const bayesRating = (ratingSum, reviews) =>
  ((ratingSum ?? 0) + RATING_PRIOR_WEIGHT * RATING_PRIOR_VALUE) / (reviews + RATING_PRIOR_WEIGHT);

// 星标对数归一：当事记录的星标相对全场最高星标的比值（对数尺度），无星标为 0。
export const starScoreOf = (stars, starsMax) =>
  stars ? Math.log10(stars + 1) / Math.log10(starsMax + 1) : 0;

// 互动固定分母：不随全场最大值缩放，早期投票不会被放大，拿满即 1。
export const engagementScoreOf = (likes, favorites) =>
  Math.min(1, Math.log10(likes + 2 * favorites + 1) / Math.log10(ENGAGEMENT_FULL + 1));

// 综合分（0-100）。
export const scoreOf = ({ stars, starsMax, reviews, ratingSum, likes, favorites }) => {
  const starsWeight = reviews ? STARS_WEIGHT_WITH_REVIEWS : STARS_WEIGHT_NO_REVIEWS;
  return (
    100 *
    (starsWeight * starScoreOf(stars, starsMax) +
      (reviews ? REVIEW_WEIGHT * (bayesRating(ratingSum, reviews) / 5) : 0) +
      ENGAGEMENT_WEIGHT * engagementScoreOf(likes, favorites))
  );
};
