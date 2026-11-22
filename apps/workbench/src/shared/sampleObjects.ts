// Test and acceptance-sample objects ("请勿处理", "验收样本") stay in the lists but start folded, so the ones in use are read first; nothing is deleted.
const marker = /请勿处理|验收样本/;
export const isSampleTitle = (title: string): boolean => marker.test(title);
