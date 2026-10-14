/**
 * Bundled offline fallback snapshot — GENERATED, do not edit by hand.
 *
 * Regenerate with:
 *   node scripts/build-fallback.mjs test/fixtures/pricing.zh.html --write
 *
 * Source page: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * `fetchedAt: 0` is deliberate: it marks the snapshot as "never fetched from the
 * network", so the host half still tries to refresh on first run.
 */

/** Offline fallback used until the first successful official fetch. */
export const FALLBACK_SNAPSHOT = {
  "schemaVersion": 1,
  "sourceUrl": "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
  "fetchedAt": 0,
  "currency": "CNY",
  "unit": "per_million_tokens",
  "models": [
    {
      "name": "deepseek-flash",
      "key": "deepseek-flash",
      "peak": {
        "inputCacheHit": 0.04,
        "inputCacheMiss": 2,
        "output": 8
      },
      "offPeak": {
        "inputCacheHit": 0.02,
        "inputCacheMiss": 1,
        "output": 4
      }
    },
    {
      "name": "deepseek-v4-pro",
      "key": "deepseek-v4-pro",
      "peak": {
        "inputCacheHit": 0.3,
        "inputCacheMiss": 9,
        "output": 27
      },
      "offPeak": {
        "inputCacheHit": 0.15,
        "inputCacheMiss": 4.5,
        "output": 13.5
      }
    }
  ],
  "rules": {
    "windows": [
      [
        540,
        720
      ],
      [
        840,
        1080
      ]
    ],
    "weekdays": [
      1,
      2,
      3,
      4,
      5
    ],
    "timeZone": "Asia/Shanghai",
    "source": "parsed",
    "peakPhase": "peak",
    "offPeakPhase": "offPeak",
    "offPeakIsHalfOfPeak": true
  },
  "notes": [
    "(1) 模型名请使用 deepseek-flash。旧模型名 deepseek-v4-flash、deepseek-v4-flash-vision-exp 仍可调用，但对应模型已下线，请求将由 DeepSeek-V4.1-Flash 模型提供服务，并按 Flash 价格计费。",
    "(2) 空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。",
    "(3) 更多并发限制细节，请参考限速与隔离。"
  ],
  "warnings": []
}
