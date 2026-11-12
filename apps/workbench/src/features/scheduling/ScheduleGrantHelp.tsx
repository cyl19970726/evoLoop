// What the schedule page says when the reader holds no creation grant: where the grant comes from and where the how-to is.
const docs = "https://github.com/cyl19970726/evoLoop/blob/main/docs/development";
const link = "text-primary underline";

export function ScheduleGrantHelp() {
  return <>取得本项目明确授权后才能创建日程。授权写在私有配置的 <code>scheduling.grants</code> 里（并把 <code>scheduling.enabled</code> 设为 true），由能改私有配置的维护者按项目、身份、范围和职责逐项开启；写法见<a className={link} href={`${docs}/local-run.md`} target="_blank" rel="noreferrer">本地运行说明</a>，其他接线见<a className={link} href={`${docs}/runtime-operations.md`} target="_blank" rel="noreferrer">运行接线手册</a>。</>;
}
