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
| `docs/design/loop-engineering-design.md` | `.companies/domain-tech-collection/docs/research/ai-virtual-office-loop-engineering-design.md` | 2026-07-19 |

公開図（cc-sier-organization 側、GitHub Pages 配信）: https://sas-sasao.github.io/cc-sier-organization/diagrams/ai-virtual-office-aws.html

## 更新履歴

| 日付 | 内容 | コピー元コミット |
|------|------|----------------|
| 2026-07-18 | 初回コピー（spawn 時） | 646a417 |
| 2026-07-19 | `requirements.md` を v0.2 に同期（ループエンジニアリング反映: §1.1-4 / NFR-8 / §5.4 / §11）、`loop-engineering-design.md` を新規コピー | 802bfc1 |
| 2026-07-19 | `loop-engineering-design.md` を v0.2 に同期（§4.1 office-qa 合格基準 verdict JSON / §3.4 開発サイクル /office-develop / game パス表記を `apps/web/game/` に修正）、`requirements.md` を v0.2.1 に同期 | 439292f |

## 内容の変更について

`requirements.md` はコピー後に **リンクのみ** 修正した（本文内容は無変更）:

- `./ai-virtual-office-design.md` への相対リンク → `./architecture-design.md`（同ディレクトリ内のファイル名変更に追従）
- cc-sier-organization 内部への相対リンク（`../../../../docs/requirements.md`）→ GitHub 絶対 URL（`https://github.com/SAS-Sasao/cc-sier-organization/blob/main/docs/requirements.md`）

`architecture-design.md` および 2 つの図ファイルは無修正でコピーした。

`loop-engineering-design.md`（2026-07-19 追加）も同じ方針でリンクのみ修正した（本文内容は無変更）:

- `./ai-virtual-office-requirements.md` → `./requirements.md`
- `./ai-virtual-office-design.md` → `./architecture-design.md`

同日の `requirements.md` v0.2 同期では上記に加え `./ai-virtual-office-loop-engineering-design.md` → `./loop-engineering-design.md` を適用した。

## 更新ルール

- 設計変更が発生した場合は cc-sier-organization 側で更新し、このリポにも反映すること
- このリポで設計を直接変更した場合は、cc-sier-organization 側にもフィードバックすること
- origin.md は削除しないこと（設計のトレーサビリティ維持のため）
- 元ファイルは cc-sier-organization 側（`.companies/domain-tech-collection/docs/research/` および `docs/diagrams/`）にそのまま温存されている。本リポの `docs/design/` はそのコピーであり、コピー元を削除・変更するものではない
