import { ArrowUpRight, Fingerprint } from 'lucide-react'
import type { NodeRecipe } from '@taktflow/core'
import { EmptyState } from '../../components/ui'
import { Link } from '../../lib/router'
import { shortHash } from '../eval/labels'
import './recipe-section.css'

/**
 * 节点抽屉"配方"区（docs/design/20 §1）：本次执行用的技能版本、prompt / 角色档案哈希、harness 与模型、召回的经验；
 * 链到该节点的成绩单。
 */
export function RecipeSection({ recipe }: { recipe?: NodeRecipe }) {
  if (!recipe) return <EmptyState compact icon={Fingerprint} title="这次执行没有配方记录" body="只有 agent / review / judge / planner 节点和 rubric 门禁会记 node.recipe。" />
  // 服务端成绩单以 workflowId + 完整 nodeId 为 key（planner 展开的任务也有自己的成绩单），与 scorecard-table cardKey 一致
  const card = `${recipe.workflowId}/${recipe.nodeId}`
  return (
    <div className="dpad recipe">
      <div className="recipe-key">
        <Fingerprint aria-hidden />
        <div>
          <div className="recipe-k">配方</div>
          <div className="mono recipe-key-v" title={recipe.recipeKey}>
            {recipe.recipeKey}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <Link to={`/eval?card=${encodeURIComponent(card)}`} className="btn btn-sm">
          节点成绩单
          <ArrowUpRight />
        </Link>
      </div>
      <dl className="facts">
        <dt>技能</dt>
        <dd>
          {recipe.skills.length === 0 ? (
            <span className="faint">没有加载技能</span>
          ) : (
            <span className="recipe-skills">
              {recipe.skills.map((s) => (
                <Link key={s.name} to={`/eval?by=skill&card=${encodeURIComponent(`${s.name}@${s.hash}`)}`} className="chip recipe-skill" title={`${s.name} · 内容哈希 ${s.hash}`}>
                  {s.name}
                  <span className="mono faint">{shortHash(s.hash, 7)}</span>
                </Link>
              ))}
            </span>
          )}
        </dd>
        <dt>Prompt</dt>
        <dd className="mono">{shortHash(recipe.promptHash, 12)}</dd>
        {recipe.role && (
          <>
            <dt>角色档案</dt>
            <dd>
              <span className="mono">{recipe.role}</span> <span className="mono faint">· {shortHash(recipe.profileHash, 12)}</span>
            </dd>
          </>
        )}
        <dt>模型</dt>
        <dd>
          <span className="mono">{recipe.model ?? '默认'}</span>
          {recipe.harness && <span className="mono faint"> · {recipe.harness}</span>}
          {recipe.effort && <span className="mono faint"> · effort {recipe.effort}</span>}
        </dd>
        <dt>Workflow</dt>
        <dd className="mono">
          {recipe.workflowId}@{recipe.workflowVersion}
          {recipe.workflowRev && <span className="faint"> · {recipe.workflowRev}</span>}
        </dd>
        <dt>经验</dt>
        <dd>
          {recipe.lessons?.length ? (
            <span className="recipe-skills">
              {recipe.lessons.map((id) => (
                <Link key={id} to="/settings?tab=lessons" className="chip mono">
                  {id}
                </Link>
              ))}
            </span>
          ) : (
            <span className="faint">没有召回</span>
          )}
          <div className="recipe-note faint">经验不计入配方键：同一配方召回不同经验仍归为一组。</div>
        </dd>
      </dl>
    </div>
  )
}
