# row-status-friend-sync — 変更概要

シートで入金済みにすると、友だちの個人情報欄の入金確認も済になります。

フォームごとに「Formaloo の field slug / alias → 個人情報の項目名」を設定できます。未設定のフォームはこれまでどおり何もしません。署名済み `fr_id` で本人と確認できた最新 row だけを反映し、値が同じなら DB を書きません。Formaloo 側を空にした場合は個人情報側も空にします。反映元と最終更新時刻は内部 metadata に残し、個人情報画面には内部 marker を出しません。

手動編集との関係は、mapping 対象の項目だけ Formaloo が正です。手動で別の値にしても次の reconcile で Formaloo 値へ戻ります。mapping していない手動項目は残ります。

制約は 2 点あります。シートから Formaloo へ送る sidebar Sync は手動です。また本件の reconcile は管理画面の回答データまたは統計を開いた時に発火し、cron には未配線です。回答後編集を有効にした `/fo` では targeted pull でも同じ反映が走ります。緊急停止 flag は既存の friend_id 復元 / prefill も同時に止めます。
