// QQ 内嵌键盘（M3 / A16；`thincoder-v2-qq-spec.md §4-5`、Hermes `keyboards.py:57-130`）。
// 🔴 `permission.type = 2` 只表示"所有人可点"，**不是权限、也不提供防重复**；
//    `click_limit = 1` 才是平台级的"点过即灰"。真正的防线永远是服务端状态判定（pending.answerable）。
export const APPROVE_BUTTON = /^approve:([^:]+):(allowed-once|rejected)$/;
export const QUESTION_BUTTON = /^question:([^:]+):(\d+)$/;

/** `render_data.label` 用纯文字：emoji 疑似导致键盘不渲染（现役注释结论）。 */
function button({ id, label, visitedLabel, style, data }) {
  return {
    id,
    render_data: { label, visited_label: visitedLabel, style },
    action: { type: 1, data, permission: { type: 2 }, click_limit: 1 },
  };
}

/** 审批键盘：`approve:<handle>:<outcome>`，handle 即控制流 eventId。 */
export function approvalKeyboard(handle) {
  return {
    content: {
      rows: [
        {
          buttons: [
            button({ id: 'ap-allow', label: '同意', visitedLabel: '已同意', style: 1, data: `approve:${handle}:allowed-once` }),
            button({ id: 'ap-deny', label: '拒绝', visitedLabel: '已拒绝', style: 0, data: `approve:${handle}:rejected` }),
          ],
        },
      ],
    },
  };
}

/** 提问键盘：协议里选项没有 id，只能按位置索引；label 用数字（长度限制）。 */
export function questionKeyboard(eventId, question) {
  const options = Array.isArray(question?.options) ? question.options.slice(0, 4) : [];
  return {
    content: {
      rows: [
        {
          buttons: options.map((option, index) =>
            button({
              id: `q-opt-${index + 1}`,
              label: String(index + 1),
              visitedLabel: `已选${index + 1}`,
              style: index === 0 ? 1 : 0,
              data: `question:${eventId}:${index}`,
            }),
          ),
        },
      ],
    },
  };
}

/** 点击回传的 `data.resolved.button_data` 必须用**锚定**正则解析（Hermes `keyboards.py:47-52`）。 */
export function parseButtonData(raw) {
  const data = String(raw ?? '');
  const approve = APPROVE_BUTTON.exec(data);
  if (approve) return { kind: 'approve', id: approve[1], outcome: approve[2] };
  const question = QUESTION_BUTTON.exec(data);
  if (question) return { kind: 'question', id: question[1], optionIndex: Number(question[2]) };
  return null;
}
