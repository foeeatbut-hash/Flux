export type OfficeFieldRefreshChange = { key: string; from: string; to: string; where: string };
export type OfficeFieldRefreshSkip = { key: string; why: string; where: string };

export type OfficeLocalFieldRefreshResult = {
  changed: OfficeFieldRefreshChange[];
  skipped: OfficeFieldRefreshSkip[];
  unchanged: boolean;
  sha256: string;
  base64: string;
};
