// DEV-ONLY review mock (`?mock=seatfree`): the body of the top-right credits
// panel under the seat-free rules. Credits belong to the workspace and every
// member draws from them. Paid plans carry two allowances, shown as two blocks
// in the same order as the web console's 套餐与余额 page:
//   - Design Plan: value models, capped per 5-hour and 7-day window, so it
//     reads as "% left + when it resets";
//   - 按量额度 (usage-based): top models, a dollar pool for the period, so it
//     reads as "$left / $total".
// Free shows only the one-off sign-up grant. Review copy is Chinese only.

import { formatMockUsd, SEAT_FREE_SIGNUP_GRANT_USD, SEAT_FREE_TIER_CREDITS, type SeatFreeMockState } from '../mock/seat-free';
import styles from './CodingPlanUsage.module.css';
import ownStyles from './SeatFreeCreditsPanel.module.css';

const RECHARGE_URL = 'http://localhost:5191/dashboard?mock=seatfree&role=owner&billing=recharge';
const CONSOLE_URL = 'http://localhost:5191/dashboard?mock=seatfree';
// Mock readings for the Design Plan windows (`dp5=` / `dp7=` override them).
const DESIGN_PLAN_WINDOWS = [
  { key: 'dp5', label: '5 小时', fallback: 82, resets: '3 小时 12 分后重置' },
  { key: 'dp7', label: '7 天', fallback: 64, resets: '5 天 6 小时后重置' },
] as const;
const LOW_SHARE = 20;

function readPercent(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  const raw = Number(new URLSearchParams(window.location.search).get(key) ?? fallback);
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : fallback;
}

function Meter({ percent }: { percent: number }) {
  const tone = percent === 0 ? ownStyles.fillEmpty : percent < LOW_SHARE ? ownStyles.fillLow : '';
  return (
    <div className={styles.track} aria-hidden>
      <span className={`${styles.fill} ${tone}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

export function SeatFreeCreditsPanelBody({ mock }: { mock: SeatFreeMockState }) {
  const isOwner = mock.role === 'owner';
  const isFree = mock.plan === 'free';
  const footer = (
    <div className={ownStyles.footer}>
      {isOwner ? (
        <span>{isFree ? '额度全员共用' : '两种额度全员共用'}</span>
      ) : (
        <span>{isFree ? '升级' : '升级或充值'}请联系 {mock.ownerName}</span>
      )}
      <a className={ownStyles.footerLink} href={CONSOLE_URL} target="_blank" rel="noreferrer">
        查看详情 →
      </a>
    </div>
  );

  if (mock.plan === 'free') {
    const percent = Math.round(Math.min(1, mock.balanceUsd / SEAT_FREE_SIGNUP_GRANT_USD) * 100);
    return (
      <div className={styles.quota} data-testid="seatfree-credits-panel">
        <div className={styles.block}>
          <div className={styles.row}>
            <span className={styles.allowance}>注册赠送额度</span>
            <span className={styles.entry}>
              <bdi>
                {formatMockUsd(mock.balanceUsd)} / {formatMockUsd(SEAT_FREE_SIGNUP_GRANT_USD)}
              </bdi>
            </span>
          </div>
          <Meter percent={percent} />
          <p className={ownStyles.sub}>仅 DeepSeek V4.1 Flash · 注册后 3 天内有效</p>
        </div>
        {footer}
      </div>
    );
  }

  const grant = SEAT_FREE_TIER_CREDITS[mock.quotaUsd] ?? 0;
  const paygTotal = Math.max(grant, mock.balanceUsd);
  const paygPercent = paygTotal > 0 ? Math.round((mock.balanceUsd / paygTotal) * 100) : 0;
  const windows = DESIGN_PLAN_WINDOWS.map((w) => ({ ...w, percent: readPercent(w.key, w.fallback) }));
  // Only point at the usage-based pool when it still has money in it.
  const designPlanOut = windows.some((w) => w.percent === 0) && mock.balanceUsd > 0;

  return (
    <div className={styles.quota} data-testid="seatfree-credits-panel">
      <section className={ownStyles.section} aria-label="Design Plan 额度">
        <p className={ownStyles.title}>Design Plan 额度</p>
        <p className={ownStyles.sub}>性价比模型 · DeepSeek、GLM、MiMo 系列</p>
        {windows.map((w) => (
          <div key={w.key} className={ownStyles.window}>
            <div className={styles.row}>
              <span className={styles.allowance}>{w.label}</span>
              <span className={`${styles.entry} ${w.percent === 0 ? ownStyles.out : ''}`}>
                {w.percent === 0 ? '已用完' : `剩余 ${w.percent}%`}
              </span>
            </div>
            <Meter percent={w.percent} />
            <p className={ownStyles.resets}>{w.resets}</p>
          </div>
        ))}
        {designPlanOut ? <p className={ownStyles.hint}>重置前可以改用按量额度的模型继续生成</p> : null}
      </section>

      <section className={ownStyles.section} aria-label="按量额度">
        <div className={styles.row}>
          <p className={ownStyles.title}>按量额度</p>
          {isOwner ? (
            <a className={ownStyles.action} href={RECHARGE_URL} target="_blank" rel="noreferrer">
              充值
            </a>
          ) : null}
        </div>
        <p className={ownStyles.sub}>顶级模型 · Claude Opus、Fable、GPT Sol 系列</p>
        {paygTotal > 0 ? (
          <>
            <div className={styles.row}>
              <span className={ownStyles.amount}>
                <bdi>{formatMockUsd(mock.balanceUsd)}</bdi>
                <span className={ownStyles.amountTotal}> / {formatMockUsd(paygTotal)}</span>
              </span>
              <span className={`${styles.entry} ${mock.balanceUsd === 0 ? ownStyles.out : ''}`}>
                {mock.balanceUsd === 0 ? '已用完' : '本期剩余'}
              </span>
            </div>
            <Meter percent={paygPercent} />
            {mock.role === 'member' ? <p className={ownStyles.resets}>你本期已用 $7.75</p> : null}
          </>
        ) : (
          <p className={ownStyles.hint}>Go 不含按量额度，充值后可用顶级模型</p>
        )}
      </section>
      {footer}
    </div>
  );
}
