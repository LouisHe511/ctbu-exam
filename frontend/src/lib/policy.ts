/**
 * 站点政策常量（2026-10-20 14:35 更新）
 *
 * ⚠️ 2026-10-20 用户决定：**取消"两台设备不能同时查看"的判定与处罚**。
 *    现在只剩一条设备规则：一个账号最多 MAX_DEVICES 台设备登录。
 *    申诉 QQ 仍然保留（用于投稿、误封、其他问题）。
 */
export const APPEAL_QQ = '3673683474';
/** 客服微信（页脚、会员页「经济困难免单」入口共用同一处，换号只改这里） */
export const SUPPORT_WECHAT = '+852 95533954';
export const MAX_DEVICES = 2;

/** 兼容旧引用的空阶梯（处罚体系已取消，别再往这里加东西） */
export const PENALTY_LADDER: readonly string[] = [];
export const WARNING_TEXT = '';
