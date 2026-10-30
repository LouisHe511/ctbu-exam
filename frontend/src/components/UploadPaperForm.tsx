import { useState, useRef } from 'react';
import { courses } from '@/data';
import { usePapers } from '@/context/PapersContext';
import { useAuth } from '@/context/AuthContext';
import { uploadPaper } from '@/lib/papers';
import { Upload, Loader2, CheckCircle, AlertCircle } from 'lucide-react';

const SEMESTERS = ['春季', '秋季', '夏季', '寒假补考'];
const EXAM_TYPES = ['期中', '期末', '补考', '重修', '其他'];
const SOURCE_TYPES: { value: string; label: string }[] = [
  { value: 'recall', label: '回忆版' },
  { value: 'original', label: '原卷' },
  { value: 'mock', label: '模拟题' },
];

export function UploadPaperForm() {
  const { session } = useAuth();
  const { refresh } = usePapers();
  const fileRef = useRef<HTMLInputElement>(null);

  const [courseId, setCourseId] = useState(courses[0]?.id ?? '');
  const [year, setYear] = useState(new Date().getFullYear());
  const [semester, setSemester] = useState('秋季');
  const [examType, setExamType] = useState('期末');
  const [sourceType, setSourceType] = useState('recall');
  const [hasAnswer, setHasAnswer] = useState(false);
  const [hasSolution, setHasSolution] = useState(false);
  const [solutionPage, setSolutionPage] = useState('');
  const [pageCount, setPageCount] = useState(1);
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const submit = async () => {
    setMsg(null);
    if (!file) {
      setMsg({ kind: 'err', text: '请先选择一个 PDF 文件' });
      return;
    }
    if (!session?.user?.id) {
      setMsg({ kind: 'err', text: '登录状态异常，请重新登录' });
      return;
    }
    const course = courses.find((c) => c.id === courseId);
    if (!course) {
      setMsg({ kind: 'err', text: '请选择课程' });
      return;
    }

    setBusy(true);
    try {
      await uploadPaper(
        {
          file,
          courseId: course.id,
          courseName: course.name,
          category: course.category,
          year,
          semester,
          examType,
          sourceType,
          hasAnswer,
          hasSolution,
          solutionPage: hasSolution && solutionPage ? Number(solutionPage) : null,
          pageCount,
          description,
        },
      );
      await refresh();
      setMsg({ kind: 'ok', text: '上传成功，试卷已上线' });
      setFile(null);
      setDescription('');
      if (fileRef.current) fileRef.current.value = '';
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : '上传失败' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-ink-850 rounded-2xl border border-gray-100 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Upload className="w-5 h-5 text-accent" />
        <h3 className="font-medium text-gray-900">上传试卷</h3>
        <span className="text-xs text-gray-500 ml-auto">一份试卷 = 一个 PDF</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-gray-500">课程</span>
          <select
            value={courseId}
            onChange={(e) => setCourseId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {courses.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs text-gray-500">年份</span>
          <input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </label>

        <label className="block">
          <span className="text-xs text-gray-500">学期</span>
          <select
            value={semester}
            onChange={(e) => setSemester(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {SEMESTERS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>

        <label className="block">
          <span className="text-xs text-gray-500">考试类型</span>
          <select
            value={examType}
            onChange={(e) => setExamType(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {EXAM_TYPES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>

        <label className="block">
          <span className="text-xs text-gray-500">来源</span>
          <select
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {SOURCE_TYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>

        <label className="block">
          <span className="text-xs text-gray-500">页数</span>
          <input
            type="number"
            min={1}
            value={pageCount}
            onChange={(e) => setPageCount(Number(e.target.value))}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </label>

        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500">说明（可选）</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="例如：2024 秋 期末 回忆版，含答案"
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </label>

        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500">PDF 文件</span>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-accent-wash file:text-accent hover:file:bg-accent-wash"
          />
        </label>

        <label className="flex items-center gap-2 sm:col-span-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={hasAnswer}
            onChange={(e) => setHasAnswer(e.target.checked)}
            className="rounded border-gray-300 text-accent focus:ring-accent"
          />
          这份试卷包含答案
        </label>

        <label className="flex items-center gap-2 sm:col-span-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={hasSolution}
            onChange={(e) => {
              setHasSolution(e.target.checked);
              if (!e.target.checked) setSolutionPage('');
            }}
            className="rounded border-gray-300 text-accent focus:ring-accent"
          />
          这份试卷包含<b>解析</b>（有解题过程，不只是答案）
        </label>

        {hasSolution && (
          <label className="block sm:col-span-2">
            <span className="text-xs text-gray-500">
              解析从 PDF 的第几页开始（可选；填了阅读器就能一键跳到解析）
            </span>
            <input
              type="number"
              min={1}
              value={solutionPage}
              onChange={(e) => setSolutionPage(e.target.value)}
              placeholder="例如 4"
              className="mt-1 w-full sm:w-40 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </label>
        )}
      </div>

      {msg && (
        <div className={`mt-4 flex items-center gap-2 text-sm rounded-lg px-3 py-2 ${
          msg.kind === 'ok' ? 'bg-accent-wash text-accent-deep' : 'bg-red-500/10 text-red-700'
        }`}>
          {msg.kind === 'ok' ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
          {msg.text}
        </div>
      )}

      <button
        onClick={submit}
        disabled={busy}
        className="mt-4 w-full sm:w-auto px-5 py-3 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-deep transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
        {busy ? '上传中…' : '上传并发布'}
      </button>
    </div>
  );
}
