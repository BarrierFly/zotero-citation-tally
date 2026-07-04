startup-begin = 引用计数正在加载
startup-finish = 引用计数已就绪
startup-progress = [{ $percent }%] { $message }
menuitem-label = 引用计数: 帮助工具样例
menupopup-label = 引用计数: 弹出菜单
menuitem-submenulabel = 引用计数
menuitem-filemenulabel = 引用计数: 文件菜单
menuitem-update-citation-tallies =
    .label = 更新引用计数
menuitem-update-all-sources =
    .label = 全部来源
menuitem-update-crossref =
    .label = 从 Crossref 更新
menuitem-update-inspire =
    .label = 从 INSPIRE 更新
menuitem-update-semanticscholar =
    .label = 从 SemanticScholar 更新
menuitem-update-openalex =
    .label = 从 OpenAlex 更新
menuitem-update-avgcite =
    .label = 更新年均引用
menuitem-retally-outdated-citations =
    .label = 重新统计过期引用
prefs-title = 引用计数
prefs-table-title = 标题
prefs-table-detail = 详情

# Progress window messages
progress-getting-citation-tallies = 正在获取引用计数
progress-getting-avgcite = 正在计算年均引用
progress-no-valid-items = 未选择有效的项目来更新引用计数。
progress-items-updated = 已为 { $count } 个项目更新了引用计数。
progress-avgcite-updated = 已为 { $count } 个项目更新了年均引用。
progress-item-counter = 项目 { $current } / { $total }

# Auto-update messages
auto-update-title = { $addonName } - 自动更新中 (点击隐藏)
auto-update-updating-outdated = 正在更新 { $count } 个过期引用...
auto-update-updating-item = 正在更新项目 { $current } / { $total }
auto-update-connection-retry = 连接问题，正在重试... ({ $current }/{ $max })
auto-update-stopped = 自动更新已停止：{ $error }
auto-update-completed = 自动更新完成：{ $updated }/{ $total } 个项目已更新

# Database display names
database-crossref = Crossref
database-inspire = INSPIRE
database-semanticscholar = SemanticScholar
database-openalex = OpenAlex

# Column and tooltip
column-citations = 引用
column-fwci = FWCI
column-avgcite = 年均引用
tooltip-citation-tallies = { $displayName }：{ $count }