import { ArrowLeft, ShieldCheck, MonitorSmartphone } from 'lucide-react';
import { APPEAL_QQ, MAX_DEVICES } from '@/lib/policy';
import { useApp } from '@/context/AppContext';

/**
 * 隐私政策页。
 *
 * ═══════════════════════════════════════════════════════════════
 * 文体（2026-10-22 用户要求整页重写）
 * ═══════════════════════════════════════════════════════════════
 * 用户原话：「很多话比较口水」「像大厂的风格做好，更书面更严谨」
 *           「不需要提到我们的服务器原来在国外」
 *
 * 上一版里被点名的口语表达（已全部删掉）：
 *   · 「用大白话讲清楚」「一句话版本」
 *   · 「需要坦白的一点」「手机和电脑同时开着看，没问题」
 *   · 「早期版本曾使用境外服务商……」 ← 用户明确要求不提历史架构
 *
 * 改写准则：
 *   ① 陈述事实与规则，不解释动机、不做自我辩解
 *   ② 人称统一为「本服务」「您」，不混用「本站 / 站长 / 你」
 *   ③ 不使用语气词、比喻、感叹（"其实""就好""没问题"）
 *   ④ 不出现任何"历史版本如何"的表述 —— 对外只有当下这一份政策
 *
 * ⚠️ 维护提醒：改了数据收集行为就要同步改本页，否则构成不实陈述。
 */

const UPDATED_AT = '2026-10-22';
const CONTACT_EMAIL = 'dyxzovo@gmail.com';

/** 收集范围 —— 与代码里的实际字段一一对应 */
const COLLECTED: { title: string; body: string }[] = [
  {
    title: '账号标识',
    body: '手机号码或电子邮箱地址（二者择一，用于注册、登录及密码找回）。',
  },
  {
    title: '身份凭证',
    body: '登录密码（选设）。密码经 PBKDF2-SHA256 不可逆散列处理后存储，本服务不保留、亦无法还原其明文。',
  },
  {
    title: '验证信息',
    body: '注册与登录环节产生的一次性短信验证码、邮件验证码及图形验证码。验证码仅用于单次身份核验，核验完成后即失效。',
  },
  {
    title: '资料信息',
    body: '学号、所属学院、年级及昵称（均为选填，由您在个人中心自主填写）。该等信息用于身份核对与会员资格认定。',
  },
  {
    title: '使用记录',
    body: '收藏的文档、浏览记录、邀请关系，以及登录设备的标识符（由浏览器生成的随机字符串，不含设备型号与硬件参数）。前述设备标识仅用于执行第六条约定的登录设备数量限制。',
  },
  {
    title: '交易记录',
    body: '会员订单的订单编号、交易金额、支付状态及会员有效期。本服务不收集、不存储您的银行卡号、支付账户或支付密码。',
  },
  {
    title: '内容水印',
    body: '文档阅读界面将叠加显示您的账号标识与当前时间。该水印用于在内容被截图外传时追溯来源。',
  },
  {
    title: '访问日志',
    body: '服务器自动记录的 IP 地址、访问时间、浏览器类型及请求路径。该等信息用于故障排查、异常请求识别与访问频率限制。',
  },
];

/** 存储地点与共享对象 —— 逐项说明，不作概括性表述 */
const STORAGE: { title: string; body: string }[] = [
  {
    title: '本服务自有服务器（中华人民共和国境内）',
    body: '账号标识、身份凭证散列值、资料信息、使用记录、交易记录及全部文档文件，均存储于本服务自行建设并维护的服务器。该服务器位于中华人民共和国境内，数据库不对公网开放。',
  },
  {
    title: '阿里云短信服务',
    body: '使用手机号码注册或登录时，手机号码与验证码内容将提交至阿里云短信服务以完成下发。该服务不获取前述以外的信息。',
  },
  {
    title: '腾讯企业邮箱服务',
    body: '使用电子邮箱注册或找回密码时，电子邮箱地址将提交至邮件服务商以完成验证邮件投递。',
  },
  {
    title: '第三方支付机构',
    body: '发生会员交易时，订单编号与交易金额将提交至具备合法资质的第三方支付机构以完成收款。该机构的信息处理规则依其自身隐私政策执行。',
  },
];

function Section({ title, items }: { title: string; items: { title: string; body: string }[] }) {
  return (
    <section className="mb-12">
      <h2 className="text-xl font-semibold tracking-tight text-gray-900 mb-5">{title}</h2>
      <dl className="space-y-5">
        {items.map((it) => (
          <div key={it.title}>
            <dt className="text-sm font-medium text-gray-900">{it.title}</dt>
            <dd className="mt-1.5 text-sm text-gray-500 leading-relaxed max-w-[52ch]">{it.body}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function PrivacyPage() {
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
            <ShieldCheck className="w-5 h-5 text-gray-700" />
            <span className="text-xs text-gray-500">生效日期：{UPDATED_AT}</span>
          </div>
          <h1 className="text-4xl font-semibold tracking-tight text-gray-900">隐私政策</h1>
          <p className="mt-3 text-base text-gray-500 leading-relaxed max-w-[52ch]">
            本政策说明本服务在提供文档检索与在线阅读功能的过程中，如何收集、使用、存储及保护您的个人信息，
            并载明您对前述信息享有的权利及其行使方式。
          </p>
        </header>

        <section className="mb-12">
          <div className="rounded-xl border border-hairline/[0.2]/30 bg-elevate/[0.06]/30 p-6">
            <p className="text-sm text-gray-900 leading-relaxed max-w-[52ch]">
              <span className="font-medium">摘要：</span>
              本服务仅收集维持功能运行所必需的信息，不出售、不交换、不用于广告投放，亦不进行用户画像。
              全部个人信息的存储与处理均在中华人民共和国境内完成。
            </p>
          </div>
        </section>

        <Section title="一、收集范围" items={COLLECTED} />
        <Section title="二、存储地点与共享对象" items={STORAGE} />

        <section className="mb-12">
          <h2 className="text-xl font-semibold tracking-tight text-gray-900 mb-5">三、处理目的</h2>
          <ul className="space-y-3 text-sm text-gray-500 leading-relaxed max-w-[52ch]">
            <li>· 完成账号注册、登录及身份核验；</li>
            <li>· 核算免费查阅额度，开通及管理会员资格；</li>
            <li>· 记录收藏与浏览历史，以支持跨会话续读；</li>
            <li>· 防止文档被批量抓取或转售，包括访问水印、额度限制与设备数量限制；</li>
            <li>· 投递验证码、密码重置等与账号直接相关的必要通知；</li>
            <li>· 排查服务故障，识别异常请求与恶意访问。</li>
          </ul>
          <p className="mt-5 text-sm text-gray-500 leading-relaxed max-w-[52ch]">
            <span className="text-gray-900 font-medium">本服务不会：</span>
            向任何第三方出售或出租您的个人信息；投放商业广告；将您的信息用于与前述目的无关的用途。
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl font-semibold tracking-tight text-gray-900 mb-5">四、保留期限</h2>
          <p className="text-sm text-gray-500 leading-relaxed max-w-[52ch]">
            账号信息于账号存续期间保留。账号注销或经您申请删除后，本服务将在合理期限内予以删除或作匿名化处理。
            涉及付费的交易记录，因需应对潜在争议或履行法定义务，保留期限相应延长。
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl font-semibold tracking-tight text-gray-900 mb-5">五、您的权利</h2>
          <ul className="space-y-3 text-sm text-gray-500 leading-relaxed max-w-[52ch]">
            <li>
              · <span className="text-gray-900 font-medium">查阅与更正</span>：
              学号、学院、年级、昵称等资料，您可在个人中心随时自行查阅并修改。
            </li>
            <li>
              · <span className="text-gray-900 font-medium">删除</span>：
              您可要求删除账号及其关联数据。
            </li>
            <li>
              · <span className="text-gray-900 font-medium">撤回同意</span>：
              您可随时停止使用本服务并申请注销账号。
            </li>
          </ul>
          <p className="mt-5 text-sm text-gray-500 leading-relaxed max-w-[52ch]">
            前述请求请发送至 <span className="text-gray-900 font-medium">{CONTACT_EMAIL}</span>，
            并注明账号标识（手机号码或电子邮箱地址）及具体诉求。本服务将在合理期限内处理并回复。
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl font-semibold tracking-tight text-gray-900 mb-5 flex items-center gap-2">
            <MonitorSmartphone className="w-5 h-5 text-gray-700" />
            六、登录设备
          </h2>
          <p className="text-sm text-gray-500 leading-relaxed max-w-[52ch]">
            文档访问权限与账号绑定。设备方面的限制规则如下。
          </p>

          <div className="mt-5 rounded-xl border border-hairline/[0.08] p-4 max-w-[52ch]">
            <p className="text-sm font-medium text-gray-900 mb-2">同时登录设备上限</p>
            <p className="text-sm text-gray-500 leading-relaxed">
              同一账号最多允许 <strong className="text-gray-900">{MAX_DEVICES} 台设备</strong>同时处于登录状态。
              在超出上限的设备上尝试登录时，系统将拒绝该次登录，并列出当前占用名额的设备。
              您可于任一已登录设备的「个人中心 → 我的设备」中移除其中一台后重新登录。
            </p>
          </div>

          <div className="mt-4 rounded-xl bg-elevate/[0.03] p-4 max-w-[52ch]">
            <p className="text-sm font-medium text-gray-900 mb-2">并发查阅</p>
            <p className="text-sm text-gray-500 leading-relaxed">
              本服务不对同一账号的并发查阅作出限制。前述 {MAX_DEVICES} 台上限仅约束登录状态，不约束同时阅读。
            </p>
          </div>

          <div className="mt-4 rounded-xl bg-elevate/[0.03] p-4 max-w-[52ch]">
            <p className="text-sm font-medium text-gray-900 mb-2">异议渠道</p>
            <p className="text-sm text-gray-500 leading-relaxed">
              如对登录设备限制或账号安全存有异议，可联系
              <strong className="text-gray-900"> 申诉 QQ {APPEAL_QQ}</strong>，
              并提供账号标识与相关时间。本服务将在 1–3 个工作日内核实，
              经核实确属误判的，将解除相应限制并删除该条记录。
            </p>
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-xl font-semibold tracking-tight text-gray-900 mb-5">七、安全措施</h2>
          <p className="text-sm text-gray-500 leading-relaxed max-w-[52ch]">
            密码以不可逆散列形式存储，任何人员（包括运营者）均无法还原其明文；全部接口在服务端校验身份与权限，
            不依赖客户端判断；数据库不对公网开放；文档文件存储于站点目录之外，
            仅可通过经身份校验后签发的短时有效链接读取，链接逾期即失效；全站通过 HTTPS 加密传输。
          </p>
          <p className="mt-4 text-sm text-gray-500 leading-relaxed max-w-[52ch]">
            本服务为个人运营项目，未取得网络安全等级保护备案，亦不具备企业级安全运维条件，
            故无法就绝对安全性作出承诺。请勿在本服务使用与其他重要账号相同的密码。
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl font-semibold tracking-tight text-gray-900 mb-5">八、未成年人</h2>
          <p className="text-sm text-gray-500 leading-relaxed max-w-[52ch]">
            本服务面向高等院校在校学生。未满 18 周岁的用户，应在监护人知情并同意的前提下使用本服务。
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl font-semibold tracking-tight text-gray-900 mb-5">九、政策更新</h2>
          <p className="text-sm text-gray-500 leading-relaxed max-w-[52ch]">
            收集范围或处理目的发生实质变更时，本服务将修订本政策并同步更新页首的生效日期。
            修订后的政策自公布之日起生效。
          </p>
        </section>

      </div>
    </div>
  );
}
