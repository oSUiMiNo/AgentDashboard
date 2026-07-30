//! 構造化履歴の読み書き（セルフホスト化設計§3-2・§3-3）。
//!
//! # 遡りはファイルではなく DB から作る
//!
//! これまでは、メモリの窓から落ちた範囲をパーサに JSONL を読み直してもらっていた
//! （初期実装§4 の `read_range`）。セルフホストでは**サーバに JSONL が存在しない**ので、
//! その手は使えない。DB を真実にすると、副産物としてパーサが縮退していても遡れる
//! ようになる——「これ以上遡れません（503）」が消える、という改善（§3-3）。
//!
//! # 同じIDは上書き
//!
//! ツールコールは結果が届いた時点で**同じIDで送り直される**（初期実装§4 の upsert 契約）。
//! 再送（§6-1）の重複もここで吸収される。主キー `(card_id, node_id)` があるので、
//! 「重複しないこと」は約束ではなく機構になっている。

use super::entity::transcript_nodes;
use protocol::{CardId, Node, NodeId, TreeNode};
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};

/// このカードで次に振る番号を求める。
///
/// 起動直後や再接続後に、**続きから振る**ために要る。0 から振り直すと、既にある行と
/// 番号がぶつかって並びが壊れる。
pub async fn next_seq<C: ConnectionTrait>(db: &C, card_id: CardId) -> Result<i64, DbErr> {
    let highest: Option<i64> = transcript_nodes::Entity::find()
        .filter(transcript_nodes::Column::CardId.eq(card_id.0))
        .select_only()
        .column_as(transcript_nodes::Column::Seq.max(), "seq")
        .into_tuple()
        .one(db)
        .await?
        .flatten();
    Ok(highest.map_or(0, |seq| seq + 1))
}

/// ノードを書き込む。`seq` は `next` から順に振り、**上書きのときは触らない**。
///
/// 番号を振り直すと、結果が届いただけのツールコールが列の末尾へ飛び、画面の並びが動く。
pub async fn append<C: ConnectionTrait>(
    db: &C,
    card_id: CardId,
    nodes: &[TreeNode],
    next: &mut i64,
) -> Result<(), DbErr> {
    if nodes.is_empty() {
        return Ok(());
    }

    let rows: Vec<transcript_nodes::ActiveModel> = nodes
        .iter()
        .map(|node| {
            let seq = *next;
            *next += 1;
            transcript_nodes::ActiveModel {
                card_id: Set(card_id.0),
                node_id: Set(node.id.0.clone()),
                parent: Set(node.parent.as_ref().map(|parent| parent.0.clone())),
                ts: Set(node.ts),
                branch: Set(node.branch as i32),
                seq: Set(seq),
                payload: Set(serde_json::to_value(&node.node).unwrap_or(serde_json::Value::Null)),
            }
        })
        .collect();

    transcript_nodes::Entity::insert_many(rows)
        .on_conflict(
            OnConflict::columns([
                transcript_nodes::Column::CardId,
                transcript_nodes::Column::NodeId,
            ])
            .update_columns([
                transcript_nodes::Column::Parent,
                transcript_nodes::Column::Ts,
                transcript_nodes::Column::Branch,
                transcript_nodes::Column::Payload,
            ])
            .to_owned(),
        )
        .exec(db)
        .await?;
    Ok(())
}

/// 巻き戻り（`/rewind`）を受けて、このカードの履歴を捨てる。
pub async fn reset<C: ConnectionTrait>(db: &C, card_id: CardId) -> Result<(), DbErr> {
    transcript_nodes::Entity::delete_many()
        .filter(transcript_nodes::Column::CardId.eq(card_id.0))
        .exec(db)
        .await?;
    Ok(())
}

/// 履歴を1ページ分読む（`?before=&limit=`。設計§3-3）。
///
/// 返すのは**古い順**。`before` を省くと手元の最新ぶんになる。第2の戻り値は
/// 「さらに前があるかもしれない」。
pub async fn page<C: ConnectionTrait>(
    db: &C,
    card_id: CardId,
    before: Option<&NodeId>,
    limit: usize,
) -> Result<(Vec<TreeNode>, bool), DbErr> {
    let boundary = match before {
        Some(before) => {
            let found = transcript_nodes::Entity::find_by_id((card_id.0, before.0.clone()))
                .one(db)
                .await?;
            match found {
                Some(row) => Some(row.seq),
                // 起点が見つからない＝そのノードを知らない。遡る先も無い
                None => return Ok((Vec::new(), false)),
            }
        }
        None => None,
    };

    let mut query =
        transcript_nodes::Entity::find().filter(transcript_nodes::Column::CardId.eq(card_id.0));
    if let Some(boundary) = boundary {
        query = query.filter(transcript_nodes::Column::Seq.lt(boundary));
    }
    // 新しい側から limit+1 件取ると、「さらに前があるか」を追加の問い合わせ無しで判定できる
    let mut rows = query
        .order_by_desc(transcript_nodes::Column::Seq)
        .limit(limit as u64 + 1)
        .all(db)
        .await?;

    let has_more = rows.len() > limit;
    if has_more {
        rows.truncate(limit);
    }
    rows.reverse();
    Ok((rows.into_iter().map(into_node).collect(), has_more))
}

/// 手元にある最新ぶん（購読を始めたクライアントへ最初に送る内容）。
pub async fn latest<C: ConnectionTrait>(
    db: &C,
    card_id: CardId,
    limit: usize,
) -> Result<Vec<TreeNode>, DbErr> {
    Ok(page(db, card_id, None, limit).await?.0)
}

fn into_node(row: transcript_nodes::Model) -> TreeNode {
    TreeNode {
        id: NodeId(row.node_id),
        parent: row.parent.map(NodeId),
        // 読めない payload は捨てずに `Unknown` へ落とす。寛容パース（初期実装§3）と
        // 同じ扱いで、**表示しないことと捨てることは別**（PJTガイドライン）
        node: serde_json::from_value(row.payload.clone()).unwrap_or(Node::Unknown {
            record_type: "db-decode-failed".to_string(),
            raw: row.payload,
        }),
        ts: row.ts,
        branch: row.branch as u32,
    }
}
