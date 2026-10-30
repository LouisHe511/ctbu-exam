import { ArrowLeft, FileText, ReceiptText } from 'lucide-react';
import { APPEAL_QQ, MAX_DEVICES } from '@/lib/policy';
import { useApp } from '@/context/AppContext';

/**
 * 会员服务条款（2026-10-30 新增）。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么加这一页
 * ─────────────────────────────────────────────────────────────
 * 微信支付与支付宝的商户审核都会看「网站是否有明确的商品信息与售后规则」。
 * 本站此前只有《隐私政策》，退款规则只散落在会员页的一句话里 —— 这是
 * 支付产品签约最容易被驳回的一项，也会在真的发生纠纷时缺依据。
 *
 * ─────────────────────────────────────────────────────────────
 * 文体
 * ─────────────────────────────────────────────────────────────
 * 与《隐私政策》一致：书面、陈述规则、不解释动机、不用语气词。
 * 人称统一「本服务」「您」；不出现「站长」「小编」。
 *
 * ⚠️ 维护提醒：价格、有效期、设备数量、退款口径一旦调整，必须同步改本页，
 *    否则构成对用户的不实陈述。价格常量本身来自 `lib/membership.ts` 的 PLANS。
 */

const UPDATED_AT = '2026-10-30';

/** 条款正文：编号 + 标题 + 条目 */
const CLAUSES: { no: string; title: string; items: string[] }[] = [
  {
    no: '一',
    title: '服务内容',
    items: [
      '本服务为重庆工商大学历年考试真题的检索与在线阅览服务，内容包括各课程历年试卷的逐页影像、部分试卷的答案与解析，以及全国大学英语四、六级考试真题的在线作答与听力播放。',
      '试卷内容仅供个人学习参考。本服务不对试卷的完整性、答案的准确性作出超出其来源的保证；如发现内容有误，可通过第九条所列方式反馈，经核实后将予更正或退还相应费用。',
      '本服务为独立运营的第三方资料整理服务，与重庆工商大学及其他院校无隶属或合作关系。',
    ],
  },
  {
    no: '二',
    title: '账号与使用限制',
    items: [
      `账号仅限注册人本人使用，不得转借、出租、出售或以其他方式提供给第三人。同一账号最多可在 ${MAX_DEVICES} 台设备上登录；经单独书面许可的账号不受此限。`,
      '为防止内容被批量抓取或转售，本服务对同一账号的并发访问、短时间内的解锁数量及下载行为设有技术限制。',
      '存在转借账号、批量下载、去除水印后传播等情形的，本服务可暂停或终止该账号的使用权限；情节严重的，将不予退还已支付费用。',
    ],
  },
  {
    no: '三',
    title: '会员与计费',
    items: [
      '会员分为单月、年度、永久三档，价格以会员购买页面实时展示者为准。下单时页面所示金额即应付金额，不另收手续费。',
      '单月与年度会员自开通时起计算有效期，到期后自动失效，不自动续费、不产生后续扣款。永久会员在服务存续期间持续有效。',
      '在会员有效期内新增的试卷，会员可直接阅览，不另行收费。',
      '本服务可能调整各档价格，调整不影响已开通会员的有效期与权益。',
    ],
  },
  {
    no: '四',
    title: '退款',
    items: [
      '本服务提供的是即时交付的数字化内容。依据《中华人民共和国消费者权益保护法》第二十五条，在线交付的数字化商品不适用七日无理由退货；本服务在此基础上提供下列退款安排。',
      '付款后七日内，且账号未解锁、未阅览任何付费内容的，可申请全额退款。',
      '因本服务原因导致无法正常使用的（如试卷内容严重错误、长期无法访问），可申请全额退款；已使用部分期间的，按未使用期限比例退款。',
      '已解锁或已阅览付费内容的，原则上不支持退款；确有特殊情况的，可联系客服协商处理。',
      '因支付通道异常导致的重复扣款、金额错误，经核对后全额退回。',
      '退款按原支付路径退回，到账时间以支付机构处理时效为准，一般为 1 至 7 个工作日。',
    ],
  },
  {
    no: '五',
    title: '内容与知识产权',
    items: [
      '本服务所整理的试卷影像、答案解析及其编排，其整理成果归本服务所有；试卷本身的著作权归原权利人。',
      '您可在个人学习范围内阅览、打印上述内容，不得用于商业用途，不得以截图、录屏、下载等方式批量复制后传播、出售或发布于其他平台。',
      '阅读界面叠加的账号标识与本机时间水印用于追溯外传来源。移除或规避该水印的，视为违反本条约定。',
    ],
  },
  {
    no: '六',
    title: '服务可用性',
    items: [
      '本服务按现有条件提供，将尽合理努力保持可用，但因设备维护、版本更新、网络故障、不可抗力或第三方服务中断导致的暂时不可用，不视为违约。',
      '计划内维护将尽可能提前在站内公告；因维护导致会员连续超过 24 小时无法使用的，相应延长会员有效期。',
      '本服务保留调整、合并或停止个别栏目的权利。停止全部服务时，将提前不少于 30 日在站内公告，并按未使用期限比例退还费用。',
    ],
  },
  {
    no: '七',
    title: '责任限制',
    items: [
      '本服务不对考试结果、成绩提升作出任何明示或默示的保证。',
      '在法律允许的范围内，本服务就单次购买承担的赔偿责任以您为该笔订单实际支付的金额为限。',
    ],
  },
  {
    no: '八',
    title: '条款的变更',
    items: [
      '本条款可能随服务内容调整而更新，更新后的条款自公示之日起生效，并在本页顶部标注生效日期。',
      '条款变更不影响变更前已生效的会员权益。若您不同意变更内容，可停止使用本服务。',
    ],
  },
  {
    no: '九',
    title: '联系与争议解决',
    items: [
      `客服渠道：QQ ${APPEAL_QQ}（工作时间 9:00–23:00）。涉及订单的咨询，请一并提供订单编号。`,
      '因本条款产生的争议，双方应先行协商；协商不成的，可向本服务经营者所在地有管辖权的人民法院提起诉讼。',
    ],
  },
];

export function ServiceTermsPage() {
  const { navigate } = useApp();

  return (
    <div className="pt-[73px] pb-24 min-h-screen bg-ink-850">
      <div className="max-w-3xl mx-auto px-5 sm:px-8">
        <button
          onClick={() => navigate({ name: 'home' })}
          className="mt-8 mb-10 inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> 返回首页
        </button>

        <header className="mb-12">
          <div className="flex items-center gap-2 mb-4">
            <FileText className="w-5 h-5 text-gray-700" />
            <span className="text-xs text-gray-500">生效日期：{UPDATED_AT}</span>
          </div>
          <h1 className="text-4xl font-semibold tracking-tight text-gray-900">会员服务条款</h1>
          <p className="mt-3 text-base text-gray-500 leading-relaxed max-w-[52ch]">
            本条款约定您在使用本服务及购买会员过程中的权利与义务，重点包括会员的计费方式、
            退款条件与内容使用范围。购买前请完整阅读；完成支付即视为同意本条款。
          </p>
        </header>

        <section className="mb-12">
          <div className="rounded-xl border border-hairline/[0.2]/30 bg-elevate/[0.06]/30 p-6">
            <p className="text-sm text-gray-900 leading-relaxed max-w-[52ch]">
              <span className="font-medium">摘要：</span>
              会员用于解锁全站试卷与答案解析，一次付费，到期不自动续费。
              付款后七日内且未阅览付费内容的，可全额退款；已阅览的，除内容错误或无法访问外不支持退款。
              账号仅限本人使用，内容不得转载或转售。
            </p>
          </div>
        </section>

        {CLAUSES.map((c) => (
          <section key={c.no} className="mb-12">
            <h2 className="text-xl font-semibold tracking-tight text-gray-900 mb-5">
              {c.no}、{c.title}
            </h2>
            <ul className="space-y-3 text-sm text-gray-500 leading-relaxed max-w-[52ch]">
              {c.items.map((t) => (
                <li key={t}>· {t}</li>
              ))}
            </ul>
          </section>
        ))}

        <section className="mb-12">
          <h2 className="text-xl font-semibold tracking-tight text-gray-900 mb-4">附：订单与发票</h2>
          <p className="flex items-start gap-2 text-sm text-gray-500 leading-relaxed max-w-[52ch]">
            <ReceiptText className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
            本服务为个人经营者提供的数字化内容服务，默认不提供发票。
            如确需报销凭证，请通过第九条所列方式联系，可开具相应票据。
          </p>
        </section>

        <div className="border-t border-hairline/[0.08] pt-6 pb-4 text-xs text-gray-400">
          本页与《隐私政策》共同构成您与本服务之间的完整约定。
        </div>
      </div>
    </div>
  );
}
