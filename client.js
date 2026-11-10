/**
 * CN-gpt 设置卡（Host 之外唯一的客户端代码）。
 *
 * 注册进插件页（Plugin Manager）的 `plugins.bundle.config` slot，key = 本包名。
 * 规范：不 import Harness Client 包；只用 --dsw-alias-* 主题 token；控件自绘；
 * 数据读写走 Host 提供的 ctx.configForms（cfgForms.get('mm-models') 的
 * getSnapshot / subscribe / mutate），不在客户端折叠会话事件。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mm-models',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * React hook 兼容层。
     *
     * 真机上是 React 提供的 useState/useEffect；离线测试的假 React 只有 createElement，
     * 所以这里做一次能力探测并给出降级实现 —— **不让离线测试因为缺 hook 而跑不起来**。
     * 降级版语义足够：useState 退化为"每次渲染都重置"，对静态渲染断言是安全的。
     */
    const useState =
      typeof React.useState === 'function'
        ? React.useState
        : (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
    const useEffect = typeof React.useEffect === 'function' ? React.useEffect : () => {}

    const PACKAGE = 'dsh-mm-models'
    const ENTRY = 'mm-models' // Host profile 条目 id（cordis.patch.yml 的行 id）
    const NS = 'mm-models.settings'

    /**
     * 卡片编辑的字段。
     *
     * kind：boolean（开关）/ text / number / **secret**（密钥，可看可改）。
     *
     * ## 密钥的存储取舍（2026-10-13 二次调整，按用户明确要求）
     *
     * 用户要求："我能在卡片上看见我填的 API key，也能编辑、修改；写进 .env 保留。"
     *
     * 于是 `secret` 字段回到卡片里，并**显示当前字面值**（配显示/隐藏切换）。
     * 必须如实说明代价：这个值会**明文落进 profile 配置**（`cordis.patch.yml`），
     * 而 profile 配置会被备份、也可能进仓库。开源仓库里不要提交它。
     *
     * 取值优先级不变（`core/keys.mjs`）：**字面值 > 引用名 > 环境变量 / `~/.dsh/.env`**。
     * 所以正确用法是二选一：
     *   - 想在卡片里看得见、随手改 → 填字面值（接受明文落盘）；
     *   - 想让密钥不进配置文件 → 留空字面值，把真值放 `~/.dsh/.env`（卡片下方引用名照旧可用）。
     *
     * 更干净的下一步（未做，需要给客户端加 RPC）：DSH 官方凭据存储
     * `@deepseek-ai/dsh-credentials`，值不进配置、轮换后下次请求即生效；
     * 但它按设计"绝不显示值"，与本需求冲突，故当前采用字面值方案。
     */
    /**
     * 毫秒字段的人类可读单位。
     *
     * 起因（2026-10-14）：这一组字段在卡片上显示的是裸毫秒（`1800000`），
     * 谁也看不出那等于 30 分钟；而它们**真的会阻塞**（同步模式最多等这么久）。
     * 这里只负责显示与校验，**不改存储值**——落盘仍是 schema 要的毫秒整数。
     *
     * `divisor` 决定用哪个单位展示：超过它就往上一级换（1000ms → 分钟 → 小时 → 天）。
     */
    const UNITS = {
      taskTimeoutMs: { kind: 'duration' },
      videoTimeoutMs: { kind: 'duration' },
      taskPollIntervalMs: { kind: 'duration' },
      taskPollMaxIntervalMs: { kind: 'duration' },
      httpTimeoutMs: { kind: 'duration' },
      healthProbeTtlMs: { kind: 'duration' },
      cacheTtlMs: { kind: 'duration' },
      ocrTimeoutMs: { kind: 'duration' },
      registryTtlMs: { kind: 'duration' },
      maxAttachImageBytes: { kind: 'bytes' },
      ocrMaxBytes: { kind: 'bytes' },
      maxCacheEntries: undefined,
    }

    /**
     * 毫秒 → 人类可读（尽量选一个读完就懂的单位）。
     * @param {number} ms - 毫秒数。
     * @returns {string} 例如 `10 分钟` / `1.5 小时` / `2 天`。
     */
    function humanMs(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const minute = 60000
      const hour = 3600000
      const day = 86400000
      if (ms < minute) return Math.round(ms / 1000) + ' 秒'
      if (ms < hour) {
        const value = ms / minute
        return (Number.isInteger(value) ? value : value.toFixed(1)) + ' 分钟'
      }
      if (ms < day) {
        const value = ms / hour
        return (Number.isInteger(value) ? value : value.toFixed(1)) + ' 小时'
      }
      const value = ms / day
      return (Number.isInteger(value) ? value : value.toFixed(1)) + ' 天'
    }

    /**
     * 超过这个值就在卡片上给出提醒。
     *
     * 为什么需要：这些超时是**同步阻塞等待**——填 30 分钟就意味着这一轮会真的卡 30 分钟。
     * schema 里没有上限（用户可以有意设很长），但**必须让人看见代价**。
     *
     * ⚠ 阈值必须**高于所有默认值**，否则默认配置自己就会报警（2026-10-14 踩到：
     * 出片默认 15 分钟，而阈值曾是 10 分钟）。当前默认：出图 3 分钟、出片 15 分钟。
     * 取 30 分钟，含义是"明显超出常规"，而不是"比默认大一点"。
     */
    const LONG_WAIT_MS = 1800000

    const FIELDS = [
      ['enableAskGlm', 'boolean', 'switches'],
      ['enableAskQwen', 'boolean', 'switches'],
      ['blockMainAgentNativeVision', 'boolean', 'switches'],
      ['blockSubagentNativeVision', 'boolean', 'switches'],
      ['blockSubagentVideoSpend', 'boolean', 'switches'],
      ['enableQwenDraw', 'boolean', 'switches'],
      ['enableSeedanceVideo', 'boolean', 'switches'],
      ['enableVideoGen', 'boolean', 'switches'],
      ['enableMinimaxVideo', 'boolean', 'switches'],
      ['enableMediaTask', 'boolean', 'switches'],
      ['enableMediaReport', 'boolean', 'switches'],
      ['enableOcrImage', 'boolean', 'switches'],
      // 2026-11-10：批量执行 + 激进模式（默认关）
      ['enableRunBatch', 'boolean', 'switches'],
      ['blockNativeShell', 'boolean', 'switches'],
      ['ocrLanguage', 'text', 'misc'],
      ['ocrTimeoutMs', 'number', 'misc'],
      ['ocrMaxChars', 'number', 'misc'],
      ['ocrMaxBytes', 'number', 'misc'],
      ['attachResultImages', 'boolean', 'switches'],
      ['maxAttachImageBytes', 'number', 'switches'],
      ['cacheResults', 'boolean', 'switches'],
      ['persistTasks', 'boolean', 'switches'],
      // 缓存加盐：改掉即让所有旧缓存失效（"我要重新生成一次"用）
      ['cacheKeySalt', 'text', 'misc'],
      // 密钥**不在 FIELDS 里**：它走官方凭据服务（见下面 KEY_ROWS 与 KeyRow），
      // 值不进 profile 配置、保存即生效。FIELDS 只管普通配置项。
      // 引用名仍在这里：凭据服务里没存时，解析回退到它指向的环境变量 / ~/.dsh/.env。
      ['dashscopeApiKeyEnv', 'text', 'keys'],
      ['arkApiKeyEnv', 'text', 'keys'],
      ['zhipuApiKeyEnv', 'text', 'keys'],
      ['minimaxApiKeyEnv', 'text', 'keys'],
      ['qwenModel', 'text', 'media'],
      ['dashscopeImageMode', 'text', 'media'],
      ['dashscopeBase', 'text', 'media'],
      ['outDir', 'text', 'media'],
      ['seedanceModel', 'text', 'media'],
      ['videoModel', 'text', 'media'],
      ['minimaxBase', 'text', 'media'],
      ['minimaxModel', 'text', 'media'],
      ['dashscopeWorkspaceId', 'text', 'media'],
      ['dashscopeVideoBase', 'text', 'media'],
      ['arkBase', 'text', 'media'],
      ['videoOutDir', 'text', 'media'],
      ['taskTimeoutMs', 'number', 'task'],
      ['videoTimeoutMs', 'number', 'task'],
      ['taskPollIntervalMs', 'number', 'task'],
      ['httpTimeoutMs', 'number', 'task'],
      ['videoCostLimitCNY', 'number', 'task'],
      ['videoSessionCostLimitCNY', 'number', 'task'],
      ['requireSpendConfirm', 'boolean', 'task'],
      ['noConfirmUnderCNY', 'number', 'task'],
      ['maxCallsPerTurn', 'number', 'task'],
      ['callBudgetIdleResetMs', 'number', 'task'],
      ['batchMaxCommands', 'number', 'task'],
      ['batchCommandTimeoutMs', 'number', 'task'],
      ['batchParallelLimit', 'number', 'task'],
      ['promptSection', 'boolean', 'misc'],
      ['degradeToText', 'boolean', 'misc'],
      ['readerGate', 'boolean', 'misc'],
      ['readerGateImageHint', 'boolean', 'misc'],
      ['readerGateForceEvidence', 'boolean', 'misc'],
      ['readerGateTimeoutMs', 'number', 'misc'],
      ['autoOcrOnImage', 'boolean', 'misc'],
      ['readerBatchMode', 'boolean', 'misc'],
      ['readerBatchMax', 'number', 'misc'],
      ['healthProbe', 'boolean', 'misc'],
      ['healthProbeTtlMs', 'number', 'misc'],
    ].map(([name, kind, group]) => ({ name, kind, group, unit: UNITS[name] }))

    /**
     * 三个密钥槽：凭据 ref、标题、用途、默认引用名。
     *
     * 值存在 DSH 官方凭据文件里（`<harness home>/.credentials.yaml`），**不进 profile 配置**；
     * 该文件 `watch=true`，写盘即重载 → 保存后下一次调用就用新 key，不用重启。
     * 没在凭据里存过时，解析回退到 `ref` 指向的环境变量 / `~/.dsh/.env`（保留你现有的用法）。
     */
    const KEY_ROWS = [
      { ref: 'DASHSCOPE_API_KEY', label: 'key.dashscope', hint: 'key.dashscopeHint' },
      { ref: 'ARK_API_KEY', label: 'key.ark', hint: 'key.arkHint' },
      { ref: 'ZHIPU_API_KEY', label: 'key.zhipu', hint: 'key.zhipuHint' },
      { ref: 'MINIMAX_API_KEY', label: 'key.minimax', hint: 'key.minimaxHint' },
    ]

    const GROUPS = [
      ['switches', 'group.switches'],
      ['keys', 'group.keys'],
      ['media', 'group.media'],
      ['task', 'group.task'],
      ['misc', 'group.misc'],
    ]

    /**
     * 四把 key 的**官方获取入口**（2026-10-13 逐一核实过，都是官方文档页）。
     * 直接放在《Key 引用名》组里，省得用户自己翻文档找。
     *
     * ⚠ 这些 key **不在本卡片里填写** —— 卡片写入是明文落盘通道。
     * 拿到之后请写进 `~/.dsh/.env` 或系统环境变量（见 hint.keys 的说明）。
     */
    const KEY_SOURCES = [
      {
        id: 'dashscope',
        label: 'key.src.dashscope',
        hint: 'key.src.dashscopeHint',
        url: 'https://www.alibabacloud.com/help/zh/model-studio/get-api-key',
      },
      {
        id: 'ark',
        label: 'key.src.ark',
        hint: 'key.src.arkHint',
        url: 'https://docs.volcengine.com/docs/ark/api-key',
        // ⚠ 方舟的 key 和"模型开通"是**两件事**：光有 key 不够，还要在开通管理页把模型开通，
        // 否则调用任何模型都返回 404 `InvalidEndpointOrModel.NotFound`（2026-10-15 实测踩到）。
        // 所以这一行必须同时给出开通入口，否则用户会卡在"key 明明是对的却调不通"。
        extra: {
          label: 'key.src.arkActivate',
          hint: 'key.src.arkActivateHint',
          url: 'https://ark.volcengine.com/region:cn-beijing/openManagement',
        },
      },
      {
        id: 'zhipu',
        label: 'key.src.zhipu',
        hint: 'key.src.zhipuHint',
        url: 'https://docs.bigmodel.cn/cn/guide/start/quick-start',
      },
      {
        id: 'minimax',
        label: 'key.src.minimax',
        hint: 'key.src.minimaxHint',
        url: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
      },
      {
        id: 'deepseek',
        label: 'key.src.deepseek',
        hint: 'key.src.deepseekHint',
        url: 'https://platform.deepseek.com/api_keys',
      },
    ]

    /**
     * 互斥开关组（与 Host 侧 core/tool-kit.mjs 的 MUTEX_GROUPS 同构）。
     *
     *   - 读图子代理二选一：ask_glm（智谱）⇄ ask_qwen（百炼 Qwen-VL）；
     *   - 出片模型三选一：seedance_video ⇄ video_gen（百炼）⇄ minimax_video。
     *
     * 打开其中一个会自动把同组其它关掉（同一个批量写入里补 set false）。
     * Host 侧还有一层 normalizeSettingsOps 兜底，所以手改配置也不会真的同时生效。
     */
    const MUTEX_GROUPS = [
      ['enableAskGlm', 'enableAskQwen'],
      ['enableSeedanceVideo', 'enableVideoGen', 'enableMinimaxVideo'],
    ]
    const mutexOf = (name) => {
      const group = MUTEX_GROUPS.find((fields) => fields.includes(name))
      return group === undefined ? [] : group.filter((field) => field !== name)
    }
    /** 需要“二选一 / 三选一”提示的开关行。 */
    const READER_FIELDS = new Set(['enableAskGlm', 'enableAskQwen'])
    const VIDEO_FIELDS = new Set(['enableSeedanceVideo', 'enableVideoGen', 'enableMinimaxVideo'])

    const DICT = {
      zh: {
        title: 'CN-gpt（读图 / 制图 / 出片）',
        intro: 'Host 半侧的配置卡；改动在保存后写入本 profile 条目。',
        save: '保存',
        discard: '放弃修改',
        saving: '保存中…',
        failed: '保存失败：Host 拒绝了写入。常见原因：取值非法，或配置在别处被改过（版本冲突）。已刷新版本，请重试；仍失败请刷新页面或重启 dsh。',
        dirty: '有未保存的修改',
        unavailable: '插件未激活，或 Host 暂未提供该配置。',
        readOnly: '当前连接为只读，无法保存。',
        note: 'Key 真值放 ~/.dsh/.env（DASHSCOPE_API_KEY / ARK_API_KEY / ZHIPU_API_KEY / MINIMAX_API_KEY），或用 设置→模型 的 GLM 行；本卡只改引用名与开关。单价表请编辑 cordis.patch.yml 的 pricing。',
        'group.switches': '工具开关（一键允许 / 禁止）',
        'group.keys': 'Key 引用名',
        'group.media': '端点与型号',
        'group.task': '任务与超时',
        'group.misc': '其它开关',
        'field.enableAskGlm': '允许 ask_glm（GLM 读图子代理）',
        'field.enableAskQwen': '允许 ask_qwen（Qwen-VL 读图子代理）',
        'field.blockMainAgentNativeVision': '屏蔽主代理原生读图（强制走读图子代理）',
        'field.blockSubagentNativeVision': '屏蔽通用子代理原生读图（读图员豁免）',
        'field.blockSubagentVideoSpend': '禁止子代理出片（出图 / 读图不受影响）',
        'hint.subagentVision': '⚠ 前提：读图员开着，且读图员行 maxDepth ≥ 2，否则子代理会失去看图途径。读图员豁免名单取自契约文件；认不出读图员时本开关对子代理不生效（见 media_report 健康报告）。',
        'field.enableQwenDraw': '允许 qwen_draw（Qwen 制图）',
        'field.enableSeedanceVideo': '允许 seedance_video（Seedance 出片）',
        'field.enableVideoGen': '允许 video_gen（百炼出片：可灵 / 万相）',
        'field.enableMinimaxVideo': '允许 minimax_video（MiniMax 海螺出片）',
        'field.enableMediaTask': '允许 media_task（重查 / 补下载）',
        'field.enableMediaReport': '允许 media_report（成本 / 健康）',
        'field.enableOcrImage': '允许 ocr_image（本地 OCR：纯文字截图抄字，不出网）',
        'field.enableRunBatch': '允许 run_batch（一次跑多条命令：测试 / 构建 / 批量检查）',
        'field.blockNativeShell': '激进模式：屏蔽原生 shell（命令只能经 run_batch 执行）',
        'hint.nativeShell': '⚠ 动地基的开关：打开后主代理不能用 pwsh / bash / ops_bash，失去交互式单步调试能力；子代理不受影响。若同时关掉 run_batch，主代理将无法执行任何命令（启动自检会告警）。改完需完整重启。',
        'field.batchMaxCommands': 'run_batch 单次命令数上限',
        'field.batchCommandTimeoutMs': 'run_batch 单条命令超时',
        'field.batchParallelLimit': 'run_batch 并行上限（parallel=true 时）',
        'field.ocrLanguage': 'OCR 语言（留空 / auto = 按内容自动选）',
        'field.ocrTimeoutMs': 'OCR 超时',
        'field.ocrMaxChars': 'OCR 返回字数上限',
        'field.ocrMaxBytes': 'OCR 图片字节上限',
        'field.attachResultImages': '把生成的图片附回模型上下文（默认关）',
        'field.maxAttachImageBytes': '附图字节上限（默认 4 MiB，0 = 不限）',
        'field.cacheResults': '出图缓存（相同 prompt 不重复计费）',
        'field.cacheKeySalt': '缓存加盐（改掉即全部失效）',
        'field.persistTasks': '登记异步任务（便于事后找回）',
        'field.dashscopeApiKey': '百炼 DashScope API Key（qwen_draw 制图 + ask_qwen 读图）',
        'field.dashscopeApiKeyEnv': 'DASHSCOPE_API_KEY 引用名',
        'field.arkApiKey': '火山方舟 Ark API Key（seedance_video 出片）',
        'field.arkApiKeyEnv': 'ARK_API_KEY 引用名',
        'field.zhipuApiKey': '智谱 API Key（ask_glm 读图）',
        'field.zhipuApiKeyEnv': 'ZHIPU_API_KEY 引用名',
        'field.minimaxApiKey': 'MiniMax API Key（minimax_video 出片）',
        'field.minimaxApiKeyEnv': 'MINIMAX_API_KEY 引用名',
        'key.set': '✅ 已配置',
        'key.unset': '⛔ 未配置',
        'key.sourceEnv': '来自环境变量 / ~/.dsh/.env',
        'key.sourceStore': '来自凭据文件（本卡片写入的）',
        'key.sourceNone': '没有来源信息',
        'key.sourceOther': '来自其它凭据层',
        'key.placeholder': '粘贴 API Key',
        'key.placeholderReplace': '已配置；填新值可覆盖',
        'key.reveal': '显示',
        'key.hide': '隐藏',
        'key.save': '保存',
        'key.clear': '清除',
        'key.readonly': '该来源为只读（例如启动时通过环境变量传入的 key），无法在这里修改。',
        'key.failed': '操作失败：请检查凭据服务是否可用。',
        'key.unavailable': '凭据服务不可用（客户端没拿到 remote.credentials）：无法在此管理密钥，请改用 ~/.dsh/.env。',
        'key.error': '读取凭据状态失败：',
        'key.dashscope': '百炼 DashScope API Key',
        'key.dashscopeHint': 'qwen_draw 制图 + ask_qwen 读图',
        'key.ark': '火山方舟 Ark API Key',
        'key.arkHint': 'seedance_video 出片',
        'key.zhipu': '智谱 BigModel API Key',
        'key.zhipuHint': 'ask_glm 读图',
        'key.minimax': 'MiniMax（海螺）API Key',
        'key.minimaxHint': 'minimax_video 出片（国内 .cn / 国际 .io 的 key 不通用）',
        'key.src.title': '去哪儿申请这些 Key（官方页面）',
        'key.src.dashscope': '阿里云百炼 DashScope API Key',
        'key.src.dashscopeHint': '（qwen_draw 制图 + ask_qwen 读图）',
        'key.src.ark': '火山方舟 Ark API Key',
        'key.src.arkActivate': '② 开通模型（关键）',
        'key.src.arkActivateHint': '有 key 还不够：方舟要在这里把模型开通，否则调用任何模型都返回 404',
        'key.src.arkHint': '（seedance_video 出片）',
        'key.src.zhipu': '智谱 BigModel API Key',
        'key.src.zhipuHint': '（ask_glm 读图）',
        'key.src.minimax': 'MiniMax 开放平台 API Key',
        'key.src.minimaxHint': '（minimax_video 出片；key 与区域必须匹配）',
        'key.src.deepseek': 'DeepSeek 开放平台 API Key',
        'key.src.deepseekHint': '（主模型用；在 设置 → 模型 里配，不在本插件）',
        'field.qwenModel': 'Qwen 制图模型',
        'field.dashscopeImageMode': '制图模式（auto / sync / async）',
        'field.dashscopeBase': 'DashScope 基址',
        'field.outDir': '图片目录',
        'field.seedanceModel': 'Seedance 模型',
        'field.videoModel': '百炼视频模型 id',
        'field.minimaxBase': 'MiniMax 基址（国内 .cn / 国际 .io）',
        'field.minimaxModel': 'MiniMax 视频模型 id',
        'field.dashscopeWorkspaceId': '百炼业务空间 ID（WorkspaceId）',
        'field.dashscopeVideoBase': '百炼视频基址（留空自动拼）',
        'field.arkBase': 'Ark 基址',
        'field.videoOutDir': '视频目录',
        'field.taskTimeoutMs': '图片任务超时（ms）',
        'field.videoTimeoutMs': '视频任务超时（ms）',
        'field.taskPollIntervalMs': '轮询间隔（ms）',
        'field.httpTimeoutMs': '单请求超时（ms）',
        'field.maxCallsPerTurn': '连续生成上限（0 = 不限）',
        'field.videoCostLimitCNY': '单次出片花费上限（元，0 = 不限）',
        'field.videoSessionCostLimitCNY': '会话累计花费上限（元，0 = 不限）',
        'field.requireSpendConfirm': '付费前必须确认金额（推荐开）',
        'field.noConfirmUnderCNY': '小额免确认阈值（元，0 = 一律要确认）',
        'field.callBudgetIdleResetMs': '空闲重置窗口（毫秒）',
        'field.promptSection': '注册分工提示词段落',
        'field.degradeToText': '读图失败给替代指引',
        'field.readerGate': '读图回合闸门（结论回来前不许开口）',
        'field.readerGateImageHint': '本轮有图未取证 → 注入提醒',
        'field.readerGateForceEvidence': '无证据收尾 → 补纠正回合',
        'field.readerGateTimeoutMs': '闸门等待上限（毫秒）',
        'field.autoOcrOnImage': '有图自动跑本地 OCR（免费，0.4s）',
        'field.readerBatchMode': '批量读图（强制数组入参）',
        'field.readerBatchMax': '批量一次最多几张',
        'field.healthProbe': '健康探测',
        'field.healthProbeTtlMs': '探测缓存 TTL（ms）',
        'unit.equals': '=',
        'unit.durationHint': '毫秒',
        'unit.longWait': '⚠ 这是同步等待：超过',
        'hint.switches': '关闭后：调用被 guard 拒绝，新会话的工具清单与提示词里不再出现；打开立即生效。',
        'hint.reader': '读图子代理二选一：打开 ask_glm 会自动关闭 ask_qwen，反之亦然；两个都关则没有读图工具。',
        'hint.readerOff': '未开启：当前没有读图子代理，需要看图请先打开上面其中一个。',
        'hint.videoMutex': '出片三选一：打开一个会自动关闭另外两个；同一时刻只允许一个出片工具生效。',
        'hint.nativeVision': '打开后：主代理自己的读图工具被摘掉，所有读图强制走上面选中的读图子代理（子代理不受影响）。改这个开关需要完整重启 dsh 才生效。',
        'hint.attachImages': '默认关：出图后只把「路径 + 规格」回给模型。打开后会把图片本身作为内容块附回上下文，由模型自己看图。注意：数 MB 的大图会触发视觉路由的上传/内联工作，失败会让整轮报 TRANSPORT；而且多数路由对单图有硬 token 上限，本来就会降采样——所以默认关。',
        'hint.keys': '密钥保存在 DSH 官方凭据文件里（<harness home>/.credentials.yaml），不进 profile 配置；写盘即重载，保存后下一次调用就用新 key，无需重启。已存的值不会显示（凭据服务按设计不回显），只报「是否已配置 + 来自哪一层」。凭据里没存过时，回退到下面的引用名 → 环境变量 / ~/.dsh/.env。',
        'hint.seedance': 'Ark 需先开通 Seedance / 提供接入点；未接通前建议保持关闭。',
        'hint.video': '百炼出片复用 DASHSCOPE_API_KEY：先填业务空间 ID，再到百炼控制台「模型市场」搜 kling 点「立即开通」；未接通前保持关闭。',
        'hint.minimax': 'MiniMax 用独立的 MINIMAX_API_KEY；国内 .cn 与国际 .io 的 key 不通用（混用会报 Invalid API key）。默认 Hailuo-02 按条计费，未计价会 fail-closed。',
      },
      en: {
        title: 'CN-gpt (read / draw / video)',
        intro: 'Host-side settings card; changes are written to this profile entry on save.',
        save: 'Save',
        discard: 'Discard',
        saving: 'Saving…',
        failed: 'Save failed: the Host rejected the write. Either a value is invalid, or the config changed elsewhere (stale revision). The revision was refreshed — retry; if it still fails, refresh the page or restart dsh.',
        dirty: 'Unsaved changes',
        unavailable: 'Plugin inactive, or the Host does not serve this configuration yet.',
        readOnly: 'This connection is read-only; saving is unavailable.',
        note: 'Key values live in ~/.dsh/.env (DASHSCOPE_API_KEY / ARK_API_KEY / ZHIPU_API_KEY / MINIMAX_API_KEY) or the Models page for GLM; this card edits references and switches only. Edit pricing in cordis.patch.yml.',
        'group.switches': 'Tool switches (one-click allow / deny)',
        'group.keys': 'Credential references',
        'group.media': 'Endpoints and models',
        'group.task': 'Tasks and timeouts',
        'group.misc': 'Other switches',
        'field.enableAskGlm': 'Allow ask_glm (GLM image reader)',
        'field.enableAskQwen': 'Allow ask_qwen (Qwen-VL image reader)',
        'field.blockMainAgentNativeVision': 'Block native image reading (force the reader subagent)',
        'field.blockSubagentNativeVision': 'Block native image reading for general subagents (readers exempt)',
        'field.blockSubagentVideoSpend': 'Block subagent video generation (images and readers unaffected)',
        'hint.subagentVision': '⚠ Requires a reader to be on and its row to have maxDepth ≥ 2, otherwise subagents lose all image access. The reader exemption list comes from the contract file; if readers cannot be identified the switch is not applied to subagents (see media_report health).',
        'field.enableQwenDraw': 'Allow qwen_draw (Qwen images)',
        'field.enableSeedanceVideo': 'Allow seedance_video (Seedance video)',
        'field.enableVideoGen': 'Allow video_gen (Bailian video: Kling / Wan)',
        'field.enableMinimaxVideo': 'Allow minimax_video (MiniMax Hailuo video)',
        'field.enableMediaTask': 'Allow media_task (re-query / download)',
        'field.enableMediaReport': 'Allow media_report (cost / health)',
        'field.enableOcrImage': 'Allow ocr_image (local OCR for text screenshots, offline)',
        'field.enableRunBatch': 'Allow run_batch (run many commands in one call: tests / builds / batch checks)',
        'field.blockNativeShell': 'Aggressive mode: block native shell (commands may only go through run_batch)',
        'hint.nativeShell': '⚠ Foundation-level switch: when on, the main agent cannot use pwsh / bash / ops_bash and loses interactive single-step debugging; subagents are unaffected. If run_batch is also disabled the agent cannot execute anything (startup self-check warns). Requires a full restart.',
        'field.batchMaxCommands': 'run_batch max commands per call',
        'field.batchCommandTimeoutMs': 'run_batch per-command timeout',
        'field.batchParallelLimit': 'run_batch parallelism limit (parallel=true)',
        'field.ocrLanguage': 'OCR language (empty / auto = pick by content)',
        'field.ocrTimeoutMs': 'OCR timeout',
        'field.ocrMaxChars': 'OCR max characters',
        'field.ocrMaxBytes': 'OCR max image bytes',
        'field.attachResultImages': 'Attach generated images back into the model context (default off)',
        'field.maxAttachImageBytes': 'Attach size cap (default 4 MiB, 0 = unlimited)',
        'field.cacheResults': 'Image cache (same prompt is not billed twice)',
        'field.cacheKeySalt': 'Cache salt (change it to invalidate all)',
        'field.persistTasks': 'Log async tasks (so you can recover them later)',
        'field.dashscopeApiKey': 'DashScope API key (qwen_draw images + ask_qwen reader)',
        'field.dashscopeApiKeyEnv': 'DASHSCOPE_API_KEY reference',
        'field.arkApiKey': 'Volcengine Ark API key (seedance_video)',
        'field.arkApiKeyEnv': 'ARK_API_KEY reference',
        'field.zhipuApiKey': 'Zhipu API key (ask_glm reader)',
        'field.zhipuApiKeyEnv': 'ZHIPU_API_KEY reference',
        'field.minimaxApiKey': 'MiniMax API key (minimax_video)',
        'field.minimaxApiKeyEnv': 'MINIMAX_API_KEY reference',
        'field.qwenModel': 'Qwen image model',
        'field.dashscopeImageMode': 'Image mode (auto / sync / async)',
        'field.dashscopeBase': 'DashScope base URL',
        'field.outDir': 'Image directory',
        'field.seedanceModel': 'Seedance model',
        'field.videoModel': 'Bailian video model id',
        'field.minimaxBase': 'MiniMax base URL (CN .cn / global .io)',
        'field.minimaxModel': 'MiniMax video model id',
        'field.dashscopeWorkspaceId': 'Bailian workspace ID',
        'field.dashscopeVideoBase': 'Bailian video base URL (blank = auto)',
        'field.arkBase': 'Ark base URL',
        'field.videoOutDir': 'Video directory',
        'field.taskTimeoutMs': 'Image task timeout (ms)',
        'field.videoTimeoutMs': 'Video task timeout (ms)',
        'field.taskPollIntervalMs': 'Poll interval (ms)',
        'field.httpTimeoutMs': 'Per-request timeout (ms)',
        'field.maxCallsPerTurn': 'Consecutive generations (0 = unlimited)',
        'field.videoCostLimitCNY': 'Per-call video spend cap (CNY, 0 = unlimited)',
        'field.videoSessionCostLimitCNY': 'Per-session video spend cap (CNY, 0 = unlimited)',
        'field.requireSpendConfirm': 'Require spend confirmation (recommended)',
        'field.noConfirmUnderCNY': 'Skip confirmation under (CNY, 0 = always confirm)',
        'field.callBudgetIdleResetMs': 'Idle reset window (ms)',
        'field.promptSection': 'Register division-of-labor prompt section',
        'field.degradeToText': 'Reader-failure fallback guidance',
        'field.readerGate': 'Reader turn gate (no answer before the result)',
        'field.readerGateImageHint': 'Image without evidence → inject reminder',
        'field.readerGateForceEvidence': 'Evidence-free stop → force a correction step',
        'field.readerGateTimeoutMs': 'Gate wait ceiling (ms)',
        'field.autoOcrOnImage': 'Auto local OCR on image turns (free, ~0.4s)',
        'field.readerBatchMode': 'Batch reading (array-only input)',
        'field.readerBatchMax': 'Max images per batch',
        'field.healthProbe': 'Health probes',
        'field.healthProbeTtlMs': 'Probe cache TTL (ms)',
        'unit.equals': '=',
        'unit.durationHint': 'milliseconds',
        'unit.longWait': '⚠ synchronous wait; over',
        'hint.switches': 'When off: calls are denied by the guard, and new sessions hide the tool from both the tool list and the prompt section; turning it on takes effect immediately.',
        'hint.reader': 'Pick exactly one image reader: turning ask_glm on turns ask_qwen off, and vice versa; with both off there is no image-reading tool.',
        'hint.readerOff': 'Not enabled: no image reader is active. Turn one of the two above on to read images.',
        'hint.videoMutex': 'Pick exactly one video generator: turning one on turns the other two off; only one video tool can be active at a time.',
        'hint.nativeVision': 'When on: the main agent loses its own image-reading tool and every image read goes through the reader selected above (subagents are unaffected). Changing this takes effect only after a full dsh restart.',
        'hint.attachImages': 'Default off: after generating, only the path + spec return to the model. When on, the image itself is attached as a content block so the model can look at it. Caveat: multi-MB images trigger the vision route upload/inline work, and a failure there fails the whole turn with TRANSPORT; most routes also hard-cap a single image and downscale it anyway — hence off by default.',
        'hint.keys': 'Keys live in the DSH credential file (<harness home>/.credentials.yaml), never in the profile config; the file is watched, so a saved key is used by the next call with no restart. Stored values are never displayed (the credential service does not return them by design) — only whether each ref is configured and which layer it comes from. When nothing is stored, resolution falls back to the reference names below → environment / ~/.dsh/.env.',
        'key.set': '✅ Configured',
        'key.unset': '⛔ Not configured',
        'key.sourceEnv': 'from environment / ~/.dsh/.env',
        'key.sourceStore': 'from the credential store (saved here)',
        'key.sourceNone': 'no source reported',
        'key.sourceOther': 'from another credential layer',
        'key.placeholder': 'Paste API key',
        'key.placeholderReplace': 'Configured; paste a new value to replace',
        'key.reveal': 'Show',
        'key.hide': 'Hide',
        'key.save': 'Save',
        'key.clear': 'Clear',
        'key.readonly': 'This source is read-only (e.g. a key passed in via the startup environment); it cannot be changed here.',
        'key.failed': 'Failed: check whether the credential service is available.',
        'key.unavailable': 'Credential service unavailable (client did not get remote.credentials): manage keys via ~/.dsh/.env instead.',
        'key.error': 'Failed to read credential status: ',
        'key.dashscope': 'Alibaba Bailian DashScope API key',
        'key.dashscopeHint': 'qwen_draw images + ask_qwen reader',
        'key.ark': 'Volcengine Ark API key',
        'key.arkHint': 'seedance_video',
        'key.zhipu': 'Zhipu BigModel API key',
        'key.zhipuHint': 'ask_glm reader',
        'key.minimax': 'MiniMax (Hailuo) API key',
        'key.minimaxHint': 'minimax_video (CN .cn and global .io keys are not interchangeable)',
        'key.src.title': 'Where to get these keys (official pages)',
        'key.src.dashscope': 'Alibaba Bailian DashScope API key',
        'key.src.dashscopeHint': 'for qwen_draw images + ask_qwen reading',
        'key.src.ark': 'Volcengine Ark API key',
        // 2026-10-15 补：这两个键中文 DICT 里有、英文段里漏了，
        // 于是英文界面直接渲染裸 i18n key，而"必须开通模型否则 404"这条**关键排障指引**
        // 在英文下完全失效。现在中英键集合相等（client-card.test.mjs 里有断言钉住）。
        'key.src.arkActivate': '② Activate the model (required)',
        'key.src.arkActivateHint':
          'A key alone is not enough: the model must be activated in the Ark console, otherwise every call returns 404',
        'key.src.arkHint': 'for seedance_video',
        'key.src.zhipu': 'Zhipu BigModel API key',
        'key.src.zhipuHint': 'for ask_glm reading',
        'key.src.minimax': 'MiniMax platform API key',
        'key.src.minimaxHint': 'for minimax_video; the key must match the region',
        'key.src.deepseek': 'DeepSeek platform API key',
        'key.src.deepseekHint': 'for the main model (configured in Settings > Models, not here)',
        'hint.seedance': 'Requires Seedance activation / an Ark endpoint; keep off until it works.',
        'hint.video': 'Bailian video reuses DASHSCOPE_API_KEY: set the workspace ID, then activate Kling in the Model Studio marketplace. Keep off until it works.',
        'hint.minimax': 'MiniMax uses its own MINIMAX_API_KEY; CN .cn and global .io keys are not interchangeable (mixing them returns Invalid API key). Hailuo-02 is billed per clip; unpriced models fail closed.',
      },
    }

    /** 极简表单模型：只依赖 scope 的 getSnapshot / subscribe / mutate（不依赖 primitives）。 */
    function createFormModel(scope, fields) {
      const staged = new Map()
      /** 互斥字段"最后被点"的顺序：值越大越晚，保存时排在后面。 */
      const mutexOrder = new Map()
      let mutexTick = 0
      const listeners = new Set()
      let baseline
      let saving = false
      let failed = false
      let state

      const raw = () => scope.getSnapshot()
      const currentValue = (name) => raw()?.value?.[name]
      const fieldOf = (name) => fields.find((spec) => spec.name === name)
      /** 字段当前显示用的文本（secret 已不走这里：密钥由凭据服务承载）。 */
      const currentText = (name) => {
        const value = currentValue(name)
        if (typeof value === 'boolean') return value ? 'true' : 'false'
        return value === undefined || value === null ? '' : String(value)
      }
      const userHas = (name) => {
        const user = raw()?.user
        return user !== null && user !== undefined && Object.hasOwn(user, name)
      }
      /**
       * 是否与当前生效值不同。
       * 用户手动改过的字段、以及互斥自动补写的字段，都以"目标值 ≠ 当前值"为准，
       * 避免把一个已经正确的值当成待保存的修改。
       */
      const isDirty = (spec, entry) => {
        if (entry === undefined) return false
        if (entry.clear) return userHas(spec.name)
        if (spec.kind === 'boolean') return (entry.text === 'true') !== (currentValue(spec.name) === true)
        return entry.text !== currentText(spec.name)
      }
      function build() {
        const snap = raw()
        const fieldsState = {}
        let dirty = false
        for (const spec of fields) {
          const entry = staged.get(spec.name)
          const text = entry === undefined ? currentText(spec.name) : entry.text
          const invalid = spec.kind === 'number' && text.trim() !== '' && !Number.isFinite(Number(text))
          const dirtyField = isDirty(spec, entry)
          if (dirtyField) dirty = true
          fieldsState[spec.name] = {
            text,
            invalid,
            dirty: dirtyField,
          }
        }
        return { available: snap?.status === 'ready', writable: snap?.writable === true, saving, failed, dirty, fields: fieldsState }
      }
      const publish = () => {
        state = build()
        for (const listener of listeners) listener()
      }

      /** 写入一个暂存值；回到当前生效值就丢弃该暂存项。 */
      function stage(name, text) {
        const spec = fieldOf(name)
        if (spec === undefined) return
        const entry = { text, clear: false }
        staged.set(name, entry)
        if (!isDirty(spec, entry)) staged.delete(name)
      }
      /**
       * 编辑一个字段。互斥对（读图子代理）被打开时，若另一个当前是开的，就一起把它关掉：
       * 两个字段都进暂存，一次保存写完，用户不必手动先关再开。
       *
       * 两个要点：
       *   1. `stage()` 不做"回到当前值就删除"的清理，否则用户刚点下的 set 会被
       *      互补补出来的 set 顶掉（点开 A 时补 B=false，A 自己的 true 反而丢了）；
       *   2. 被点开的那个记下"最后被点"的顺序，保存时它的 set 排在互补 set 之后
       *      —— 配置写入末次生效，顺序错了就会两个都开着。
       */
      function edit(name, text) {
        const spec = fieldOf(name)
        if (spec === undefined) return
        baseline ??= raw()
        stage(name, text)
        const complements = mutexOf(name)
        if (complements.length > 0 && spec.kind === 'boolean') {
          mutexOrder.set(name, ++mutexTick)
          // 只有"打开"才需要互斥处理；关闭一个开关不牵连其它。
          if (text === 'true') {
            for (const complement of complements) {
              const complementOn = staged.has(complement) ? staged.get(complement).text === 'true' : currentValue(complement) === true
              if (complementOn) stage(complement, 'false')
            }
          }
        }
        failed = false
        publish()
      }
      function discard() {
        if (staged.size === 0 && !failed) return
        staged.clear()
        mutexOrder.clear()
        baseline = undefined
        failed = false
        publish()
      }
      async function save() {
        if (saving || raw()?.writable !== true) return
        if (fields.some((spec) => state.fields[spec.name]?.invalid)) return
        const ops = []
        const delayed = []
        for (const spec of fields) {
          const entry = staged.get(spec.name)
          const name = spec.name
          if (!isDirty(spec, entry)) continue
          if (entry.clear) {
            if (userHas(name)) ops.push({ op: 'unset', path: [name] })
            continue
          }
          if (spec.kind === 'boolean') {
            const op = { op: 'set', path: [name], value: entry.text === 'true' }
            // 互斥组：被点开的那个要排在自动关闭的那些之后（末次写入生效）。
            if (mutexOf(name).length === 0) ops.push(op)
            else delayed.push({ name, op })
            continue
          }
          const text = entry.text.trim()
          if (text === '') {
            if (userHas(name)) ops.push({ op: 'unset', path: [name] })
            continue
          }
          ops.push({ op: 'set', path: [name], value: spec.kind === 'number' ? Number(text) : text })
        }
        delayed
          .sort((left, right) => (mutexOrder.get(left.name) ?? 0) - (mutexOrder.get(right.name) ?? 0))
          .forEach((item) => ops.push(item.op))
        if (ops.length === 0) {
          staged.clear()
          mutexOrder.clear()
          publish()
          return
        }
        saving = true
        failed = false
        publish()
        try {
          const landed = await scope.mutate(ops, baseline?.revision)
          if (landed) {
            staged.clear()
            mutexOrder.clear()
            baseline = undefined
          } else {
            failed = true
            // 2026-10-17：保存被拒后刷新 baseline。
            // 之前只在"成功/放弃"时清 baseline，于是一次版本冲突（例如配置文件在别处被改过）
            // 会让后面每次重试都拿同一个过期 revision 继续撞墙 —— 用户只能点"放弃修改"。
            // 刷新后下一次重试用当前 revision；若仍失败，文案会提示刷新页面/重启。
            const fresh = raw()
            if (fresh !== undefined) baseline = fresh
          }
        } catch (_error) {
          failed = true
          const fresh = raw()
          if (fresh !== undefined) baseline = fresh
        } finally {
          saving = false
          publish()
        }
      }

      const unsubscribe = typeof scope.subscribe === 'function' ? scope.subscribe(() => publish()) : () => {}
      state = build()
      return {
        store: {
          getSnapshot: () => state,
          subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        },
        actions: { edit, save, discard },
        dispose() {
          unsubscribe()
          listeners.clear()
        },
      }
    }

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)' },
      intro: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' },
      card: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)' },
      groupTitle: { margin: 0, fontSize: '14px', fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', minHeight: '28px' },
      column: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      label: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      input: { width: '260px', boxSizing: 'border-box', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', outline: 'none' },
      inputInvalid: { borderColor: 'var(--dsw-alias-state-error-primary)' },
      switchTrack: (on, disabled) => ({ position: 'relative', flex: 'none', width: '36px', height: '20px', padding: 0, border: 'none', borderRadius: '999px', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, background: on ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l3)', transition: 'background 150ms' }),
      switchKnob: (on) => ({ position: 'absolute', top: '2px', left: on ? '18px' : '2px', width: '16px', height: '16px', borderRadius: '50%', background: '#fff', transition: 'left 150ms' }),
      primaryBtn: (disabled) => ({ padding: '6px 14px', border: 'none', borderRadius: '6px', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, background: 'var(--dsw-alias-button-primary-fill)', color: '#fff', fontSize: '13px' }),
      secondaryBtn: (disabled) => ({ padding: '6px 14px', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: '13px' }),
      footer: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      status: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      warn: { fontSize: '12px', color: 'var(--dsw-alias-state-warning-primary, #b45309)' },
      error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      note: { margin: 0, fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
      sources: { display: 'flex', flexDirection: 'column', gap: '6px', margin: '2px 0 4px' },
      sourceExtraRow: { display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '6px', paddingLeft: '12px', borderLeft: '2px solid var(--dsw-alias-border-secondary, #e5e7eb)' },
      sourceRow: { display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' },
      sourceLink: { fontSize: '12px', color: 'var(--dsw-alias-state-business-primary)', textDecoration: 'underline' },
      sourceHint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      // ---- 密钥行的样式（2026-10-15 补）----
      // 这五个键此前**只在 JSX 里被引用、从未定义**：`style={undefined}` 不报错，
      // 所以配置卡能渲染，但密钥行会退化成"输入框与三个按钮纵向堆叠"，徽标也没有颜色。
      // 教训：样式键名写错/漏定义是**静默**的，React 不会提醒 —— 改样式表时要顺带
      // 在测试里断言"被引用的每个样式键都有定义"（client-card.test.mjs 已加静态自检）。
      keyRow: { display: 'flex', flexDirection: 'column', gap: '6px' },
      secretRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      secretInput: {
        flex: '1 1 220px',
        width: 'auto',
        minWidth: 0,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      },
      // ⚠ 必须是**对象**而不是函数：使用点是 `style: styles.miniBtn`（不是 `miniBtn(disabled)`），
      // 写成函数会让 React 收到非法 style。禁用态交给原生 `disabled` 属性表达。
      miniBtn: {
        padding: '4px 10px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '6px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
      },
      badgeOn: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary, #15803d)' },
    }

    function FieldControl(props) {
      const { t, spec, fieldState, disabled, onEdit } = props
      const label = h('span', { style: styles.label }, t('field.' + spec.name))
      /** 开关行的补充说明：Seedance 未接通、读图子代理二选一 / 当前未开、原生读图屏蔽。 */
      const hint = (on) => {
        if (spec.name === 'enableSeedanceVideo') return t('hint.seedance')
        if (spec.name === 'enableVideoGen') return t('hint.video')
        if (spec.name === 'enableMinimaxVideo') return t('hint.minimax')
        if (spec.name === 'blockMainAgentNativeVision') return t('hint.nativeVision')
        if (spec.name === 'blockSubagentNativeVision') return t('hint.subagentVision')
        if (spec.name === 'blockNativeShell') return t('hint.nativeShell')
        if (spec.name === 'attachResultImages' || spec.name === 'maxAttachImageBytes') return t('hint.attachImages')
        if (READER_FIELDS.has(spec.name)) return on ? t('hint.reader') : t('hint.readerOff')
        if (VIDEO_FIELDS.has(spec.name)) return t('hint.videoMutex')
        return undefined
      }
      if (spec.kind === 'boolean') {
        const on = fieldState.text === 'true'
        const note = hint(on)
        return h(
          'div',
          { style: styles.row },
          h('div', { style: styles.column }, label, note === undefined ? null : h('span', { style: styles.status }, note)),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              'aria-checked': on,
              'aria-label': t('field.' + spec.name),
              disabled,
              onClick: () => onEdit(spec.name, on ? 'false' : 'true'),
              style: styles.switchTrack(on, disabled),
            },
            h('span', { style: styles.switchKnob(on) }),
          ),
        )
      }
      const note = hint(false)
      // 毫秒字段：把裸数字翻成人类可读（`1800000` → `30 分钟`），超长等待再给一句提醒。
      // 起因：这一组字段是**同步阻塞等待**，填太大真的会把一轮卡住，而裸毫秒看不出代价。
      const raw = Number(fieldState.text)
      const unit = spec.unit
      const isDuration = unit !== undefined && unit.kind === 'duration'
      const human = isDuration && Number.isFinite(raw) && raw > 0 ? humanMs(raw) : ''
      const tooLong = isDuration && Number.isFinite(raw) && raw > LONG_WAIT_MS
      return h(
        'div',
        { style: styles.row },
        h(
          'div',
          { style: styles.column },
          label,
          !isDuration ? null : h('span', { style: styles.status }, human.length === 0 ? t('unit.durationHint') : t('unit.equals') + ' ' + human),
          tooLong ? h('span', { style: styles.warn }, t('unit.longWait') + ' ' + humanMs(LONG_WAIT_MS)) : null,
        ),
        h('input', {
          type: spec.kind === 'number' ? 'number' : 'text',
          value: fieldState.text,
          disabled,
          'aria-invalid': fieldState.invalid ? true : undefined,
          'aria-label': t('field.' + spec.name),
          onChange: (event) => onEdit(spec.name, event.target.value),
          style: fieldState.invalid ? { ...styles.input, ...styles.inputInvalid } : styles.input,
        }),
      )
      // MiniMax 卡：vendored 页面自己容错，失败不影响本包设置卡。
      try { if (minimaxPage && typeof minimaxPage.apply === 'function') minimaxPage.apply(ctx) } catch (error) { console.error('[dsh-mm-models] minimax page failed to mount:', error) }
    }

    function Card(props) {
      const { t, view } = props
      if (view === 'summary') return null
      if (typeof props.useMmModels !== 'function') return null
      const state = props.useMmModels((snapshot) => snapshot)
      // hook 必须在组件顶层调用（不能在下面的循环里），所以这里先取凭据状态。
      const credentialState = useCredentialState(props.credentials)
      const tr = (key) => (typeof t === 'function' ? t(key) : key)
      if (state.available !== true) return h('p', { style: styles.intro }, tr('unavailable'))
      const disabled = state.writable !== true || state.saving === true
      const children = [h('p', { key: 'intro', style: styles.intro }, tr('intro'))]
      for (const [groupId, groupKey] of GROUPS) {
        const specs = FIELDS.filter((spec) => spec.group === groupId)
        // keys 组的内容全部来自凭据服务（FIELDS 里只剩引用名），所以不能因为 specs 为空就跳过。
        if (specs.length === 0 && groupId !== 'keys') continue
        const rows =
          groupId === 'keys'
            ? [
                credentialState.status === 'unavailable'
                  ? h('p', { key: 'cred-unavailable', style: styles.error }, tr('key.unavailable'))
                  : null,
                credentialState.status === 'error'
                  ? h('p', { key: 'cred-error', style: styles.error }, tr('key.error') + ' ' + credentialState.message)
                  : null,
                ...KEY_ROWS.map((row) =>
                  h(KeyRow, {
                    key: row.ref,
                    t: tr,
                    row,
                    entry: credentialState.entries[row.ref],
                    credentials: props.credentials,
                    disabled,
                  }),
                ),
              ]
            : specs.map((spec) =>
                h(FieldControl, {
                  key: spec.name,
                  t: tr,
                  spec,
                  fieldState: state.fields[spec.name],
                  disabled,
                  onEdit: props.edit,
                }),
              )
        if (groupId === 'switches') {
          rows.push(h('p', { key: 'hint', style: styles.note }, tr('hint.switches')))
          rows.push(h('p', { key: 'hint-reader', style: styles.note }, tr('hint.reader')))
          rows.push(h('p', { key: 'hint-video', style: styles.note }, tr('hint.videoMutex')))
        }
        if (groupId === 'keys') {
          // 官方获取入口：折叠块，默认展开，放在引用名输入框**上面**。
          rows.unshift(
            h(
              'details',
              { key: 'sources', open: true },
              h('summary', { style: styles.sourceLink }, tr('key.src.title')),
              h(
                'div',
                { style: styles.sources },
                ...KEY_SOURCES.map((source) =>
                  h(
                    'div',
                    { key: source.id, style: styles.sourceRow },
                    h(
                      'a',
                      {
                        href: source.url,
                        target: '_blank',
                        rel: 'noreferrer noopener',
                        style: styles.sourceLink,
                      },
                      tr(source.label),
                    ),
                    h('span', { style: styles.sourceHint }, tr(source.hint)),
                    // 第二入口（目前只有方舟需要）：key 之外的"开通模型"，缺了它 key 也调不通。
                    source.extra === undefined
                      ? null
                      : h(
                          'div',
                          { key: source.id + '-extra', style: styles.sourceExtraRow },
                          h(
                            'a',
                            {
                              href: source.extra.url,
                              target: '_blank',
                              rel: 'noreferrer noopener',
                              style: styles.sourceLink,
                            },
                            tr(source.extra.label),
                          ),
                          h('span', { style: styles.sourceHint }, tr(source.extra.hint)),
                        ),
                  ),
                ),
              ),
            ),
          )
          rows.push(h('p', { key: 'hint', style: styles.note }, tr('hint.keys')))
        }
        children.push(h('section', { key: groupId, style: styles.card }, h('h4', { style: styles.groupTitle }, tr(groupKey)), ...rows))
      }
      children.push(
        h(
          'div',
          { key: 'footer', style: styles.footer },
          h('button', { type: 'button', disabled: disabled || !state.dirty, onClick: () => props.save(), style: styles.primaryBtn(disabled || !state.dirty) }, tr('save')),
          h('button', { type: 'button', disabled: disabled || !state.dirty, onClick: () => props.discard(), style: styles.secondaryBtn(disabled || !state.dirty) }, tr('discard')),
          state.saving ? h('span', { key: 'saving', style: styles.status }, tr('saving')) : null,
          state.failed ? h('span', { key: 'failed', style: styles.error }, tr('failed')) : null,
          state.dirty && !state.saving ? h('span', { key: 'dirty', style: styles.status }, tr('dirty')) : null,
        ),
      )
      children.push(h('p', { key: 'note', style: styles.note }, tr('note')))
      // MiniMax 区块（2026-11-10 合并）：并入本包设置卡，不再单独占设置侧栏。
      if (minimaxPage && typeof minimaxPage.MiniMaxCard === 'function') {
        children.push(
          h(
            'section',
            { key: 'minimax', style: styles.card },
            h('h4', { style: styles.groupTitle }, 'MiniMax Code（积分 / 签到 / 订阅额度 / 模型清单）'),
            h(minimaxPage.MiniMaxCard, { t: (k) => k }),
          ),
        )
      }
      return h('div', { style: styles.page }, ...children)
    }


    /**
     * 需要 Host 注入的能力。
     *
     * `remote.credentials` 是 DSH 官方凭据服务的客户端一侧（`dsh-api-settings-controller`
     * 的 `credentialsController` contribution，由 `dsh-api-remotes` 客户端组合挂载）：
     *   - `set(ref, value)`  写入凭据文件（`<harness home>/.credentials.yaml`，watch=true → 立即生效）
     *   - `unset(ref)`       移除
     *   - `describe([refs])` → `{ configured, source?, writable }`，**绝不返回值**
     *
     * 用法照抄官方 `dsh-client-ui-settings-models`：inject 里声明 `'remote.credentials'`，
     * 运行时用 `ctx.remote.credentials` 取到那个命名空间。
     */
    const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials']

    /**
     * 从客户端上下文取官方凭据命名空间。
     *
     * ⚠ 这里踩过两个坑（2026-10-13，实测"全都显示未配置"）：
     *   1. 官方客户端用的是 **`ctx.remote.credentials`**，不是 `ctx.get('credentials')`
     *      （官方 `dsh-client-ui-settings-models` 全库搜不到后者）；
     *   2. 远端调用返回的是 **RemoteResult**：`{ ok: true, value }` 或 `{ ok: false, error }`，
     *      必须判 `ok` 再取 `value` —— 直接 `await` 拿到的不是数据。
     *
     * 两个都写错时 `credentials` 恒为 undefined，`describe` 一次都不会被调用，
     * 表现就是"四把 key 全显示未配置"。所以这里两条路都试，并且把失败原因留给 UI 呈现。
     *
     * @param {object} ctx - Client 插件上下文。
     * @returns {object|undefined} 归一化后的 { describe, set, unset }。
     */
    function resolveCredentialApi(ctx) {
      const candidates = [
        ['remote.credentials', ctx?.remote?.credentials],
        ['get(credentials)', typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined],
        ['remote.credentials (lazy)', undefined],
      ]
      for (const [label, candidate] of candidates) {
        if (candidate !== undefined && candidate !== null && typeof candidate.describe === 'function') {
          return { api: candidate, source: label }
        }
      }
      return undefined
    }

    /** 解包 RemoteResult：{ok,value} → 值；已是裸值时原样返回。 */
    function unwrapRemote(response) {
      if (response !== null && typeof response === 'object' && typeof response.ok === 'boolean') {
        if (response.ok === true) return response.value
        const message = response.error?.message ?? response.error?.code ?? 'remote call failed'
        throw new Error(String(message))
      }
      return response
    }

    /**
     * 凭据状态：向官方凭据服务问四把 key 的 `{configured, source, writable}`。
     *
     * 关键约束（官方设计）：`describe` **绝不返回值**，所以卡片不可能回显已存的 key ——
     * 这正是"值不进配置文件"能成立的原因。卡片能做的是：报状态、报来源、接受新值。
     *
     * @param {object|undefined} credentials - resolveCredentialApi 的结果包装。
     */
    function useCredentialState(credentials) {
      const [snapshot, setSnapshot] = useState({
        status: credentials === undefined ? 'unavailable' : 'loading',
        entries: {},
        source: credentials?.source,
      })
      useEffect(() => {
        if (credentials === undefined || typeof credentials.api?.describe !== 'function') return undefined
        let alive = true
        const load = async () => {
          try {
            const result = unwrapRemote(await credentials.api.describe(KEY_ROWS.map((row) => row.ref)))
            if (!alive) return
            setSnapshot({ status: 'ready', entries: result ?? {}, source: credentials.source })
          } catch (error) {
            if (!alive) return
            setSnapshot({ status: 'error', entries: {}, source: credentials.source, message: String(error?.message ?? error) })
          }
        }
        load()
        return () => {
          alive = false
        }
      }, [credentials])
      return snapshot
    }

    /**
     * 一个密钥行：状态徽标 + 新值输入（掩码，可显示）+ 保存/清除。
     *
     * 不显示已存值（服务不提供），所以输入框永远从空开始；"已填写/未填写 + 来源"
     * 由 `describe` 提供，足以判断"我配好没有、它在哪一层生效"。
     */
    function KeyRow(props) {
      const { t, row, entry, credentials, disabled } = props
      const [draft, setDraft] = useState('')
      const [revealed, setRevealed] = useState(false)
      const [busy, setBusy] = useState(false)
      const [failed, setFailed] = useState(false)

      const configured = entry?.configured === true
      const writable = entry?.writable !== false
      const sourceKey =
        entry?.source === 'environment' || entry?.source === 'env'
          ? 'key.sourceEnv'
          : entry?.source === 'store' || entry?.source === 'file'
            ? 'key.sourceStore'
            : entry?.source === undefined
              ? 'key.sourceNone'
              : 'key.sourceOther'
      const locked = disabled || busy || credentials === undefined || !writable

      const run = async (fn) => {
        setBusy(true)
        setFailed(false)
        try {
          await fn()
          setDraft('')
        } catch (_error) {
          setFailed(true)
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { style: styles.keyRow },
        h(
          'div',
          { style: styles.column },
          h('span', { style: styles.label }, t(row.label)),
          h(
            'span',
            { style: configured ? styles.badgeOn : styles.status },
            configured ? t('key.set') + '｜' + t(sourceKey) : t('key.unset'),
          ),
          h('span', { style: styles.status }, t(row.hint)),
        ),
        h(
          'div',
          { style: styles.secretRow },
          h('input', {
            type: revealed ? 'text' : 'password',
            autoComplete: 'off',
            spellCheck: false,
            value: draft,
            disabled: locked,
            placeholder: configured ? t('key.placeholderReplace') : t('key.placeholder'),
            'aria-label': t(row.label),
            onChange: (event) => setDraft(event.target.value),
            style: { ...styles.input, ...styles.secretInput },
          }),
          h(
            'button',
            {
              type: 'button',
              disabled,
              'aria-label': (revealed ? t('key.hide') : t('key.reveal')) + ' ' + t(row.label),
              onClick: () => setRevealed(!revealed),
              style: styles.miniBtn,
            },
            revealed ? t('key.hide') : t('key.reveal'),
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: locked || draft.trim().length === 0,
              'aria-label': t('key.save') + ' ' + t(row.label),
              onClick: () => run(async () => unwrapRemote(await credentials.api.set(row.ref, draft.trim()))),
              style: styles.miniBtn,
            },
            t('key.save'),
          ),
          configured
            ? h(
                'button',
                {
                  type: 'button',
                  disabled: locked,
                  'aria-label': t('key.clear') + ' ' + t(row.label),
                  onClick: () => run(async () => unwrapRemote(await credentials.api.unset(row.ref))),
                  style: styles.miniBtn,
                },
                t('key.clear'),
              )
            : null,
        ),
        locked && writable === false ? h('span', { style: styles.status }, t('key.readonly')) : null,
        failed ? h('span', { style: styles.error }, t('key.failed')) : null,
      )
    }

    /**
     * 挂载设置卡：Host 服务 `mm-models` 命名空间期间注册到插件页的组合包配置 slot。
     * @param {object} ctx - Client 插件上下文。
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, DICT), 'mm-models: settings dictionary')
      // 官方凭据服务（可选：缺失时密钥区降级为"不可用"提示，不影响其它配置项）。
      // 取法必须用 `ctx.remote.credentials`（官方写法），不是 `ctx.get('credentials')`。
      const credentials = resolveCredentialApi(ctx)
      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY], () => {
            const scope = ctx.configForms.get(ENTRY)
            const model = createFormModel(scope, FIELDS)
            const offSlot = ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: PACKAGE,
                  locale: NS,
                  inject: () => ({ hooks: { mmModels: model.store }, ...model.actions, credentials, t }),
                },
                Card,
              ),
            )
            return () => {
              if (typeof offSlot === 'function') offSlot()
              model.dispose()
            }
          }),
        'mm-models: settings page',
      )
    }

    /* ---------------------------------------------------------------------
     * MiniMax Code 设置卡（vendored 自 dsh-minimax-connect 0.3.0，MIT，
     * Copyright (c) 2026 VICqiufeeng；见 THIRD_PARTY_NOTICES.md）。
     * 只改了三处：路由前缀、设置命名空间（llm-minimax -> mm-minimax）、
     * 以及不再占用 plugins.bundle.config（那个 key 属于本包自己的设置卡）。
     * ------------------------------------------------------------------- */
    const minimaxPage = (function () {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		let react = require("react");
		let jsx = require("react/jsx-runtime");

		/** Loader row id — the settings namespace, and the provider route key. */
		const SETTINGS_NS = "mm-minimax";
		/** Locale dictionary id for this card's copy. */
		const COPY_NS = "settings.minimax-connect";
		/** Package name, as `package.json` declares it. */
		const BUNDLE = "dsh-mm-models";

		const STATUS = "/plugins/dsh-mm-models/minimax/status";
		const MODELS = "/plugins/dsh-mm-models/minimax/models";
		const SAVE = "/plugins/dsh-mm-models/minimax/__save";
		const CLAIM = "/plugins/dsh-mm-models/minimax/signin/claim";

		async function getJson(url, init) {
			const r = await fetch(url, {
				...init,
				headers: { accept: "application/json", "content-type": "application/json", ...(init?.headers ?? {}) },
			});
			const text = await r.text();
			try { return JSON.parse(text); } catch { return { error: `HTTP ${r.status}: ${text.slice(0, 200)}` }; }
		}
		async function postJson(url, body) {
			return getJson(url, { method: "POST", body: JSON.stringify(body) });
		}

		const fmt = (n) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "—");

		/**
		 * Compact a token count.
		 *
		 * Rounded to at most one decimal and with the trailing `.0` dropped, so
		 * the catalogue's 512000 / 1000000 / 128000 read as 512K / 1M / 128K
		 * rather than 512K / 1M / 128.00000000000001K.
		 */
		function kfmt(n) {
			if (typeof n !== "number" || !Number.isFinite(n)) return "—";
			const scale = n >= 1e6 ? [1e6, "M"] : [1e3, "K"];
			const value = Math.round((n / scale[0]) * 10) / 10;
			return `${value}${scale[1]}`;
		}

		const CSS = `
[data-dsh-mm]{display:flex;flex-direction:column;gap:12px}
[data-dsh-mm] .mm-row{display:flex;gap:12px;flex-wrap:wrap}
[data-dsh-mm] .mm-card{flex:1 1 200px;border:1px solid var(--dsh-border,#33353c);border-radius:10px;padding:14px}
[data-dsh-mm] .mm-big{font-size:28px;font-weight:600;line-height:1.2}
[data-dsh-mm] .mm-muted{opacity:.65;font-size:12px}
[data-dsh-mm] .mm-hd{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
[data-dsh-mm] button{padding:7px 13px;border-radius:8px;border:1px solid transparent;background:var(--dsh-accent,#3b6ef6);
  color:#fff;cursor:pointer;font:inherit}
[data-dsh-mm] button:disabled{background:transparent;border-color:var(--dsh-border,#4a4d55);opacity:.6;cursor:default;color:inherit}
[data-dsh-mm] button.mm-ghost{background:transparent;border-color:var(--dsh-border,#4a4d55);color:inherit}
[data-dsh-mm] .mm-list{border:1px solid var(--dsh-border,#33353c);border-radius:10px;overflow:hidden}
[data-dsh-mm] .mm-item{padding:10px 12px;border-bottom:1px solid var(--dsh-border,#33353c)}
[data-dsh-mm] .mm-item:last-child{border-bottom:0}
[data-dsh-mm] .mm-top{display:flex;align-items:center;gap:10px}
[data-dsh-mm] .mm-name{font-weight:500}
[data-dsh-mm] .mm-spacer{flex:1}
[data-dsh-mm] label{display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;white-space:nowrap}
[data-dsh-mm] .mm-sub{margin-top:4px;font-size:12px;opacity:.65}
[data-dsh-mm] .mm-err{color:#ff8a80;font-size:12px;white-space:pre-wrap}
[data-dsh-mm] .mm-ok{color:#4ade80;font-size:12px}
[data-dsh-mm] table{border-collapse:collapse;font-size:12px;width:100%}
[data-dsh-mm] th,[data-dsh-mm] td{border-bottom:1px solid var(--dsh-border,#33353c);padding:5px 8px;text-align:left}
`;

		/**
		 * One line saying who keeps the credential alive.
		 *
		 * The card used to imply MiniMax Code had to be running for the provider
		 * to work. The host half renews the OAuth grant on its own now, so the
		 * line reports that instead — and calls out the one case that still needs
		 * the desktop app: a record with no refreshToken in it.
		 */
		function renewalLine(data) {
			const r = data.selfRenewal;
			if (!r) return null;
			if (!r.hasRefreshToken) return { cls: "mm-err", text: "凭据没有 refreshToken，需在 MiniMax Code 里重新登录一次" };
			if (r.blocked) return { cls: "mm-err", text: `自动续期暂停，${new Date(r.blockedUntil).toLocaleTimeString()} 后重试` };
			if (r.inFlight) return { cls: "mm-ok", text: "正在自动续期…" };
			const done = typeof r.generation === "number" && r.generation > 0 ? `，已自动续期 ${r.generation} 次` : "";
			return { cls: "mm-ok", text: `自动续期已启用（到期前 ${Math.round(r.marginMs / 60000)} 分钟${done}），不用打开 MiniMax Code` };
		}

		/** Points, check-in and account in one row. */
		function Overview({ data, onClaim, busy, note }) {
			const p = data.points;
			const s = data.signin;
			// Never dead-end the button: an already-claimed day or an unknown
			// status value still gets a clickable control that reports the
			// server's verbatim result. Only an in-flight request disables it.
			const canClaim = !busy;
			const renewal = data.signedIn || data.selfRenewal ? renewalLine(data) : null;
			return jsx.jsxs("div", { className: "mm-row", children: [
				jsx.jsxs("div", { className: "mm-card", children: [
					jsx.jsx("div", { className: "mm-muted", children: "积分余额" }),
					jsx.jsx("div", { className: "mm-big", children: p ? fmt(p.remaining) : "—" }),
					p ? jsx.jsx("div", { className: "mm-muted", children: `已用 ${fmt(p.consumed)} / 授予 ${fmt(p.granted)}` }) : null,
				]}),
				jsx.jsxs("div", { className: "mm-card", children: [
					jsx.jsx("div", { className: "mm-muted", children: "每日签到" }),
					jsx.jsx("div", { className: "mm-big", children: s ? (s.claimedToday ? "已领" : "待领") : "—" }),
					s ? jsx.jsx("div", { className: "mm-muted", children: `今日 +${s.todayPoints ?? 0} 积分` }) : null,
					jsx.jsx("button", {
						disabled: !canClaim,
						onClick: onClaim,
						children: busy ? "签到中…" : (s && s.claimedToday ? "已签到 · 重新核对" : "立即签到"),
					}),
					note ? jsx.jsx("div", { className: /成功|已签到/.test(note) ? "mm-ok" : "mm-err", children: note }) : null,
				]}),
				jsx.jsxs("div", { className: "mm-card", children: [
					jsx.jsx("div", { className: "mm-muted", children: "账号" }),
					jsx.jsx("div", { children: data.signedIn ? "已登录 MiniMax Code" : "未登录" }),
					data.expiresAtMs ? jsx.jsx("div", { className: "mm-muted", children: `token 到期 ${new Date(data.expiresAtMs).toLocaleString()}` }) : null,
					renewal ? jsx.jsx("div", { className: renewal.cls, children: renewal.text }) : null,
					!data.signedIn && data.reason ? jsx.jsx("div", { className: "mm-err", children: data.reason }) : null,
				]}),
			] });
		}

		/**
		 * The account's plan, quota, and what it buys.
		 *
		 * Every field here comes from the commerce routes the MiniMax Code
		 * desktop client itself calls (`/matrix/api/v1/...`), read by the host
		 * half. A field the service did not send reads "接口未返回" instead of
		 * a guess — the tier catalogue on the pricing page is marketing data
		 * that these APIs do not publish, so the card reports the account's own
		 * state and nothing more.
		 *
		 * The model roster shown at the bottom is the account's working
		 * catalogue (read from MiniMax Code's own provider config), which is
		 * the honest answer to "which models does my plan include" for the
		 * models this plugin can actually reach.
		 */
		function Membership({ membership, models }) {
			const m = membership;
			if (!m) return null;
			if (!m.ok) {
				return jsx.jsx("div", { className: "mm-card mm-err", children: `无法读取订阅信息：${m.reason ?? "未知原因"}` });
			}
			const amount = (v) => (v === null || v === undefined ? "接口未返回" : fmt(v));
			const plan = m.planName
				?? (m.hasTokenPlan ? "倍用量套餐" : (m.subscriptionType && m.subscriptionType !== "none" ? m.subscriptionType : "未订阅（仅免费额度）"));
			const rows = [
				["套餐", plan],
				["订阅类型", m.subscriptionType ?? "接口未返回"],
				["倍用量", m.multiplier === null || m.multiplier === undefined ? "接口未返回" : `${m.multiplier}x`],
				["额度余额", amount(m.remaining)],
				["　其中订阅额度", amount(m.purchasedRemaining)],
				["　其中免费额度", amount(m.freeRemaining)],
				["待入账", amount(m.pendingCredit)],
				["每日登录赠送", amount(m.dailyGiftRemaining)],
				["到期时间", m.expiresAtMs ? new Date(m.expiresAtMs).toLocaleString() : (m.hasTokenPlan ? "接口未返回" : "无固定到期时间")],
				["自动续费", m.willRenew ? "是" : "否"],
				["续费周期", m.upgradeAction ?? "接口未返回"],
				["可升级", m.canUpgrade ? "是" : "否"],
				["工作区", m.workspaceName ?? "接口未返回"],
			];
			const names = (models ?? []).map((x) => x.name ?? x.id);
			return jsx.jsxs("div", { className: "mm-card", children: [
				jsx.jsxs("div", { className: "mm-hd", children: [
					jsx.jsxs("div", { children: [
						jsx.jsx("div", { className: "mm-name", children: "订阅额度" }),
						jsx.jsx("div", { className: "mm-muted", children: m.hasTokenPlan ? "倍用量套餐已开通" : "未开通倍用量套餐，当前使用免费额度" }),
					] }),
				] }),
				jsx.jsx("div", { className: "mm-list", style: { marginTop: "10px" }, children: rows.map(([k, v]) => jsx.jsx("div", { className: "mm-item", children: jsx.jsxs("div", { className: "mm-top", children: [
					jsx.jsx("span", { className: "mm-name", children: k }),
					jsx.jsx("span", { className: "mm-spacer" }),
					jsx.jsx("span", { children: v }),
				] }) }, k)) }),
				names.length > 0 ? jsx.jsx("div", { className: "mm-sub", style: { marginTop: "8px" }, children: `当前账号可用模型：${names.join("、")}` }) : null,
			] });
		}

		/**
		 * What the catalogue says about one model, as one muted line.
		 *
		 * `video` is reported but not offered: the Anthropic Messages transport
		 * this provider speaks carries text and image parts only, so listing a
		 * video input as selectable would promise something the wire cannot send.
		 */
		function modelFacts(m, maxCtx) {
			const parts = [`上下文 ${kfmt(maxCtx ? m.contextMax : m.context)}`];
			if (m.contextMax > m.context) parts.push(`（可选 ${kfmt(m.contextMax)}）`);
			parts.push(`　输出 ${kfmt(m.maxTokens)}`);
			if (m.vision) parts.push("　模型支持图像");
			if (m.video) parts.push("　目录含视频输入（传输层只送图文）");
			if (m.thinking === "forced_on") parts.push("　思考模式强制开启");
			else if (m.thinking === "switchable") parts.push("　思考模式可切换");
			if (m.filesApi) parts.push("　支持文件上传");
			if (Array.isArray(m.efforts) && m.efforts.length > 0) {
				const ladder = m.efforts.filter((x) => x !== "default").join("/");
				const dflt = m.defaultEffort ? `，默认 ${m.defaultEffort}` : "";
				parts.push(`　思考档位 ${ladder}${dflt}`);
			}
			if (m.maxAttachments > 0) parts.push(`　单轮附件上限 ${m.maxAttachments}`);
			if (m.reasoningSummary) parts.push(`　思考摘要 ${m.reasoningSummary}`);
			return parts.join("");
		}

		/**
		 * The desktop client's own defaults, as one muted line.
		 *
		 * `defaultModel` is written `provider/model`, so only the model id is
		 * shown. A build that publishes none of these fields yields nothing at
		 * all rather than a row of dashes.
		 */
		function desktopLine(desktop, models) {
			if (!desktop) return null;
			const id = typeof desktop.defaultModel === "string" ? desktop.defaultModel.split("/").pop() : null;
			const named = id ? (models ?? []).find((m) => m.id === id) : undefined;
			const parts = [];
			if (id) parts.push(`桌面端默认模型 ${named ? named.name : id}`);
			if (desktop.defaultEffort) parts.push(`思考档位 ${desktop.defaultEffort}`);
			if (typeof desktop.defaultContextWindow === "number") parts.push(`上下文 ${kfmt(desktop.defaultContextWindow)}`);
			return parts.length > 0 ? parts.join("　") : null;
		}

		/** The configurable model list. */
		function ModelList({ rows, draft, setDraft, activeCount, totalCount, source, desktop, onRefresh, refreshing }) {
			const setEnabled = (id, on) => setDraft((d) => ({ ...d, enabled: { ...d.enabled, [id]: on } }));
			const setImage = (id, mode) => setDraft((d) => ({ ...d, image: { ...d.image, [id]: mode } }));
			const defaults = desktopLine(desktop, rows);
			return jsx.jsxs("div", { className: "mm-card", children: [
				jsx.jsxs("div", { className: "mm-hd", children: [
					jsx.jsxs("div", { children: [
						jsx.jsx("div", { className: "mm-name", children: "模型" }),
						jsx.jsxs("div", { className: "mm-muted", children: [`已启用 ${activeCount} / ${totalCount}`, source ? `　来源：${source}` : ""] }),
						defaults ? jsx.jsx("div", { className: "mm-muted", children: defaults }) : null,
					] }),
					jsx.jsxs("div", { style: { display: "flex", gap: "8px" }, children: [
						jsx.jsx("button", { className: "mm-ghost", disabled: refreshing, onClick: onRefresh, children: refreshing ? "读取中…" : "重新获取模型" }),
					] }),
				] }),
				jsx.jsx("div", { className: "mm-list", style: { marginTop: "10px" }, children: rows.map((m) => jsx.jsxs("div", { className: "mm-item", children: [
					jsx.jsxs("div", { className: "mm-top", children: [
						jsx.jsx("label", { children: [
							jsx.jsx("input", { type: "checkbox", checked: draft.enabled[m.id] !== false, onChange: (e) => setEnabled(m.id, e.target.checked) }),
							jsx.jsx("span", { className: "mm-name", children: m.name }),
						] }),
						jsx.jsx("span", { className: "mm-spacer" }),
						m.vision ? jsx.jsx("label", { children: [
							"图像输入",
							jsx.jsx("select", {
								value: draft.image[m.id] ?? "auto",
								onChange: (e) => setImage(m.id, e.target.value),
								children: ["auto", "on", "off"].map((v) => jsx.jsx("option", { value: v, children: v === "auto" ? "自动" : v === "on" ? "开" : "关" }, v)),
							}),
						] }) : jsx.jsx("span", { className: "mm-muted", children: "纯文本模型" }),
					] }),
					jsx.jsx("div", { className: "mm-sub", children: modelFacts(m, draft.maxCtx) }),
				] }, m.id)) }),
			] });
		}

		/**
		 * Write one field through the host's config form.
		 *
		 * `ConfigFormController.set` runs the edit through `remote.settings.mutate`
		 * with the revision the mirror currently holds, so a concurrent change
		 * elsewhere surfaces as a conflict the controller recovers from rather
		 * than as a silent overwrite. It resolves `false` when the write did not
		 * land.
		 */
		async function saveThroughForm(form, field, value) {
			try {
				const landed = await form.set(field, value);
				return landed === false
					? { ok: false, errorName: "conflict", error: "设置已在别处被修改，已重新读取，请再保存一次" }
					: { ok: true };
			} catch (error) {
				return { ok: false, errorName: error?.name ?? "unknown", error: String(error?.message ?? error) };
			}
		}

		/**
		 * Write one field through the plugin's own route.
		 *
		 * Kept as the fallback for hosts whose settings service does not publish
		 * this namespace (a row the Loader has not activated, or a build without
		 * `configForms`). The host half answers with the value it read back, so a
		 * write that did not land is reported instead of assumed.
		 */
		async function saveThroughRoute(field, value) {
			try {
				return await postJson(SAVE, { field, value });
			} catch (error) {
				return { ok: false, errorName: error?.name ?? "unknown", error: String(error?.message ?? error) };
			}
		}

		function MiniMaxCard({ t, form }) {
			const [data, setData] = react.useState(null);
			const [modelData, setModelData] = react.useState(null);
			const [draft, setDraft] = react.useState({ enabled: {}, image: {}, maxCtx: false });
			const [busy, setBusy] = react.useState(false);
			const [saving, setSaving] = react.useState(false);
			const [note, setNote] = react.useState("");
			const [saveNote, setSaveNote] = react.useState("");
			const [refreshing, setRefreshing] = react.useState(false);
			const [dirty, setDirty] = react.useState(false);

			/**
			 * Read the status + model rows.
			 *
			 * `adopt` decides whether the fetched values replace the draft. It is
			 * passed explicitly rather than inferred, because the save path must
			 * adopt (the document is now the truth) while a background interval
			 * must not (it would silently discard staged edits).
			 */
			const loadAll = react.useCallback(async (refresh, adopt) => {
				try { setData(await getJson(STATUS)); } catch (e) { setData({ __failed: String(e.message ?? e) }); }
				try {
					const m = await getJson(MODELS + (refresh ? "?refresh=1" : ""));
					setModelData(m);
					if (adopt) {
						const enabled = {};
						const image = {};
						for (const row of m.models ?? []) {
							enabled[row.id] = row.enabled !== false;
							image[row.id] = row.imageMode ?? "auto";
						}
						setDraft({ enabled, image, maxCtx: m.preferMaximumContext === true });
					}
				} catch (e) { setModelData({ __failed: String(e.message ?? e) }); }
			}, []);

			react.useEffect(() => { loadAll(false, true); }, [loadAll]);
			react.useEffect(() => {
				const id = window.setInterval(() => {
					getJson(STATUS).then(setData).catch(() => {});
				}, 30000);
				return () => window.clearInterval(id);
			}, []);

			const claim = react.useCallback(async () => {
				setBusy(true); setNote("");
				try {
					// Read the balance before the claim so the note can say whether
					// points actually landed, instead of claiming "success" blindly.
					const before = await getJson(STATUS).then((x) => x?.points?.remaining).catch(() => undefined);
					const r = await postJson(CLAIM, {});
					const s = await getJson(STATUS);
					setData(s);
					if (r.ok !== true) { setNote(`签到失败：${r.error ?? "未知原因"}`); return; }
					const after = s && s.points ? s.points.remaining : undefined;
					const gain = typeof before === "number" && typeof after === "number" ? after - before : 0;
					const cr = r.data && typeof r.data.claim_result === "number" ? `，claim_result=${r.data.claim_result}` : "";
					setNote(gain > 0.001 ? `签到成功，+${gain.toFixed(2)} 分${cr}` : `今日已签到，无新增积分${cr}`);
				} catch (e) { setNote(`签到失败：${String(e.message ?? e)}`); }
				finally { setBusy(false); }
			}, []);

			const markDirty = (fn) => { setDirty(true); setSaveNote(""); setDraft(fn); };

			const save = react.useCallback(async () => {
				setSaving(true); setSaveNote("");
				try {
					const edits = [
						["enabledModelIds", draft.enabled],
						["imageOverrides", draft.image],
						["useMaximumContextWindow", draft.maxCtx],
					];
					for (const [field, value] of edits) {
						const r = form !== undefined
							? await saveThroughForm(form, field, value)
							: await saveThroughRoute(field, value);
						if (r.ok !== true) {
							setSaveNote(`保存失败（${field}）：${r.error ?? r.errorName ?? "未知"}`);
							return;
						}
					}
					setSaveNote("已保存");
					setDirty(false);
					await loadAll(false, true);
				} catch (e) { setSaveNote(`保存失败：${String(e?.message ?? e)}`); }
				finally { setSaving(false); }
			}, [draft, form, loadAll]);

			if (data === null) return jsx.jsx("div", { "data-dsh-mm": "", children: jsx.jsx("div", { className: "mm-muted", children: "读取中…" }) });
			if (data.__failed) return jsx.jsx("div", { "data-dsh-mm": "", children: jsx.jsx("div", { className: "mm-err", children: `无法读取状态：${data.__failed}` }) });

			const rows = modelData?.models ?? [];
			const activeCount = rows.filter((m) => draft.enabled[m.id] !== false).length;

			return jsx.jsxs("div", { "data-dsh-mm": "", children: [
				jsx.jsx(Overview, { data, onClaim: claim, busy, note }),
				jsx.jsx(Membership, { membership: data.membership, models: rows }),
				modelData?.__failed
					? jsx.jsx("div", { className: "mm-card mm-err", children: `无法读取模型：${modelData.__failed}` })
					: jsx.jsx(ModelList, {
						rows,
						draft,
						setDraft: markDirty,
						activeCount,
						totalCount: rows.length,
						source: modelData?.source,
						desktop: modelData?.desktop,
						refreshing,
						onRefresh: async () => { setRefreshing(true); await loadAll(true, !dirty); setRefreshing(false); },
					}),
				jsx.jsxs("div", { className: "mm-card", children: [
					jsx.jsxs("div", { className: "mm-hd", children: [
						jsx.jsxs("label", { children: [
							jsx.jsx("input", {
								type: "checkbox",
								checked: draft.maxCtx,
								onChange: (e) => markDirty((d) => ({ ...d, maxCtx: e.target.checked })),
							}),
							"使用最大上下文窗口（消耗更多积分）",
						] }),
						jsx.jsxs("div", { style: { display: "flex", gap: "8px", alignItems: "center" }, children: [
							saveNote ? jsx.jsx("span", { className: saveNote === "已保存" ? "mm-ok" : "mm-err", children: saveNote }) : null,
							jsx.jsx("button", {
								className: "mm-ghost",
								disabled: !dirty || saving,
								onClick: () => { setDirty(false); setSaveNote(""); loadAll(false, true); },
								children: "放弃修改",
							}),
							jsx.jsx("button", { disabled: !dirty || saving, onClick: save, children: saving ? "保存中…" : "保存" }),
						] }),
					] }),
					dirty ? jsx.jsx("div", { className: "mm-muted", style: { marginTop: "6px" }, children: "有未保存的修改" }) : null,
					form === undefined
						? jsx.jsx("div", { className: "mm-muted", style: { marginTop: "6px" }, children: `设置面板未就绪，保存将经由插件路由写入 ${SETTINGS_NS}` })
						: null,
				] }),
				(data.errors ?? []).length > 0 ? jsx.jsx("div", { className: "mm-card mm-err", children: data.errors.join("\n") }) : null,
			] });
		}

		function installStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-dsh-mm-css]")) return;
			const tag = document.createElement("style");
			tag.dataset.dshMmCss = "1";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		const zh = { "row.navLabel": "MiniMax", "row.title": "MiniMax Code（积分）" };
		const en = { "row.navLabel": "MiniMax", "row.title": "MiniMax Code (points)" };

		function apply(ctx) {
			try {
				installStyles();
				ctx.effect(() => ctx.locale.register(COPY_NS, { zh, en }), "dsh-mm-models: settings copy");
				const t = ctx.locale.bind(COPY_NS);

				/**
				 * The host's form for this plugin's own settings namespace.
				 *
				 * `configForms.get` keys on the Loader row id, so it must be
				 * `SETTINGS_NS` — asking for the locale id or the package name
				 * returns a controller bound to a namespace nothing serves, and
				 * every write through it would be rejected.
				 */
				let form;
				if (typeof ctx.configForms?.get === "function") {
					try { form = ctx.configForms.get(SETTINGS_NS); } catch { form = undefined; }
				}
				const face = () => (form === undefined ? { t } : { t, form });

				/** Seat the card in one slot; a slot the build does not declare is skipped. */
				const seat = (slot, options) => {
					try {
						ctx.effect(() => ctx.slots.inject(slot, () => ctx.slots.register({
							name: slot,
							locale: COPY_NS,
							inject: face,
							...options,
						}, MiniMaxCard)), `dsh-mm-models: ${slot}`);
					} catch (error) {
						console.error(`[dsh-mm-models/minimax] slot "${slot}" failed to register:`, error);
					}
				};

				// The Settings sidebar page. `settings.section` is a list slot, so
				// its cell key is `id` and the nav label is a thunk the shell
				// re-reads on every projection.
				// （合并后不再占用 plugins.bundle.config：那个 key 归 mm-models 自己的设置卡。）
				seat("plugins.row.config", { key: `${BUNDLE}#${SETTINGS_NS}` });

				// The models page's per-provider seat, dispatched by the provider's
				// own settings namespace — which is this plugin's row id.
				seat("settings.models.provider-card", { key: SETTINGS_NS });
			} catch (error) {
				console.error("[dsh-mm-models/minimax] settings page failed to load (host provider unaffected):", error);
			}
		}

		exports.MiniMaxCard = MiniMaxCard;
		exports.apply = apply;
		exports.inject = ["slots", "locale", "configForms"];
		exports.name = "dsh-mm-models-client";
		return module.exports;
    })();


    return { inject, apply }
  },
})
