/** 两个 CLI 会话记录浓缩后的统一消息格式 */
export interface SessionMessage {
  /** 事件时间戳，epoch 毫秒（源数据缺失时为 0，同时计入 warnings） */
  ts: number;
  who: "user" | "assistant";
  /** kimi 的 turn.steer（用户中途纠偏）标记为 "steer"，普通消息无此字段 */
  kind?: "steer";
  text: string;
}

export interface ParseResult {
  messages: SessionMessage[];
  /** 解析失败或字段缺失的行数。不许静默降级，调用方应据此告警 */
  warnings: number;
}
