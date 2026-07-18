# 設計成果物の出自情報

## ソース

- **リポジトリ**: https://github.com/SAS-Sasao/cc-sier-organization
- **組織**: domain-tech-collection
- **コピー日**: 2026-07-18
- **コピー元コミット**: 646a417adc87c4adcdbca9bc6c7b054c60fe3916
- **作業者**: SAS-Sasao

## コピーした成果物

| ファイル | コピー元パス | 作成日 |
|---------|------------|--------|
| `docs/design/requirements.md` | `.companies/domain-tech-collection/docs/research/ai-virtual-office-requirements.md` | 2026-07-18 |
| `docs/design/architecture-design.md` | `.companies/domain-tech-collection/docs/research/ai-virtual-office-design.md` | 2026-07-17 |
| `docs/design/aws-architecture.drawio` | `docs/diagrams/ai-virtual-office-aws.drawio` | 2026-07-18 |
| `docs/design/aws-architecture.cfn.yaml` | `docs/diagrams/ai-virtual-office-aws.yaml` | 2026-07-18 |

公開図（cc-sier-organization 側、GitHub Pages 配信）: https://sas-sasao.github.io/cc-sier-organization/diagrams/ai-virtual-office-aws.html

## 内容の変更について

`requirements.md` はコピー後に **リンクのみ** 修正した（本文内容は無変更）:

- `./ai-virtual-office-design.md` への相対リンク → `./architecture-design.md`（同ディレクトリ内のファイル名変更に追従）
- cc-sier-organization 内部への相対リンク（`../../../../docs/requirements.md`）→ GitHub 絶対 URL（`https://github.com/SAS-Sasao/cc-sier-organization/blob/main/docs/requirements.md`）

`architecture-design.md` および 2 つの図ファイルは無修正でコピーした。

## 更新ルール

- 設計変更が発生した場合は cc-sier-organization 側で更新し、このリポにも反映すること
- このリポで設計を直接変更した場合は、cc-sier-organization 側にもフィードバックすること
- origin.md は削除しないこと（設計のトレーサビリティ維持のため）
- 元ファイルは cc-sier-organization 側（`.companies/domain-tech-collection/docs/research/` および `docs/diagrams/`）にそのまま温存されている。本リポの `docs/design/` はそのコピーであり、コピー元を削除・変更するものではない
