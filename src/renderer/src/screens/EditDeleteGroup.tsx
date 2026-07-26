import { PencilIcon, TrashIcon } from './icons'

// 담당 B — 수정/삭제 아이콘 버튼 쌍 (앱 전역 공용). 자주 쓰는 질문·API 키 등 항목 수정/삭제가
// 필요한 모든 곳에서 이 컴포넌트로 통일한다.

interface Props {
  onEdit: () => void
  onDelete: () => void
  editTitle?: string
  deleteTitle?: string
  /** 두 버튼 모두에 적용. 한쪽만 막으려면 editDisabled/deleteDisabled 사용 */
  disabled?: boolean
  editDisabled?: boolean
  deleteDisabled?: boolean
}

export function EditDeleteGroup({
  onEdit,
  onDelete,
  editTitle = '수정',
  deleteTitle = '삭제',
  disabled,
  editDisabled,
  deleteDisabled,
}: Props) {
  return (
    <div className="edit-delete-group">
      <button
        type="button"
        className="edg-btn"
        title={editTitle}
        onClick={onEdit}
        disabled={disabled || editDisabled}
      >
        <PencilIcon size={14} />
      </button>
      <span className="edg-divider" />
      <button
        type="button"
        className="edg-btn danger"
        title={deleteTitle}
        onClick={onDelete}
        disabled={disabled || deleteDisabled}
      >
        <TrashIcon size={14} />
      </button>
    </div>
  )
}
