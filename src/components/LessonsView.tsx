import React, { useState } from 'react';
import { 
  BookOpen, 
  CheckCircle2, 
  XCircle, 
  HelpCircle, 
  Award, 
  ChevronRight,
  TrendingUp,
  ShieldCheck,
  Zap
} from 'lucide-react';
import { LEARNING_LESSONS } from '../data/lessons';
import { LearningLesson } from '../types';

export const LessonsView: React.FC = () => {
  const [selectedLesson, setSelectedLesson] = useState<LearningLesson>(LEARNING_LESSONS[0]);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState<boolean>(false);

  const handleSelectLesson = (lesson: LearningLesson) => {
    setSelectedLesson(lesson);
    setSelectedAnswer(null);
    setHasSubmitted(false);
  };

  const handleSelectOption = (index: number) => {
    if (hasSubmitted) return;
    setSelectedAnswer(index);
  };

  const handleSubmitQuiz = () => {
    if (selectedAnswer === null) return;
    setHasSubmitted(true);
  };

  const isCorrect = selectedAnswer === selectedLesson.quiz.correctIndex;

  return (
    <div id="lessons-view-root" className="space-y-6">
      
      {/* Header Banner */}
      <div className="rounded-2xl bg-gradient-to-r from-stone-900 via-stone-900 to-stone-950 border border-stone-800 p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-1">
          <span className="flex h-2 w-2 rounded-full bg-amber-400"></span>
          <span className="text-xs font-semibold uppercase tracking-wider text-amber-400">
            Quantitative Curriculum
          </span>
        </div>
        <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-100">
          Crypto Investment & Systematic Execution Academy
        </h2>
        <p className="text-xs sm:text-sm text-stone-400 mt-1 max-w-2xl">
          Master the mathematical principles of 1-2W cycle entries, asymmetric 1/3rd harvest ladders, dynamic zero-risk breakeven ratchets, and institutional order flow decomposition.
        </p>
      </div>

      {/* Main Grid: Lesson List + Lesson Content */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Sidebar Lesson Picker */}
        <div className="lg:col-span-4 space-y-2.5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-stone-400 px-1 mb-2">
            Curriculum Modules ({LEARNING_LESSONS.length})
          </h3>
          {LEARNING_LESSONS.map((lesson) => {
            const isSelected = lesson.id === selectedLesson.id;
            return (
              <button
                key={lesson.id}
                id={`lesson-item-${lesson.id}`}
                onClick={() => handleSelectLesson(lesson)}
                className={`w-full text-left p-3.5 rounded-xl border transition-all ${
                  isSelected
                    ? 'bg-amber-500/15 border-amber-500/40 text-stone-100 shadow-sm'
                    : 'bg-stone-900/60 border-stone-800 text-stone-400 hover:text-stone-200 hover:bg-stone-900'
                }`}
              >
                <div className="flex items-center justify-between text-[10px] font-semibold text-amber-400 mb-1">
                  <span>{lesson.category}</span>
                  <span className="text-stone-500">{lesson.readTime}</span>
                </div>
                <h4 className="font-bold text-xs sm:text-sm text-stone-200">{lesson.title}</h4>
                <p className="text-[11px] text-stone-400 mt-1 line-clamp-2">{lesson.summary}</p>
              </button>
            );
          })}
        </div>

        {/* Selected Lesson Reader & Quiz */}
        <div className="lg:col-span-8 space-y-6">
          <div className="p-5 sm:p-6 rounded-2xl bg-stone-900 border border-stone-800 space-y-6">
            
            {/* Lesson Title Bar */}
            <div className="border-b border-stone-800 pb-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-400 mb-1">
                <span>{selectedLesson.category}</span>
                <span>•</span>
                <span className="text-stone-400">{selectedLesson.difficulty}</span>
                <span>•</span>
                <span className="text-stone-400">{selectedLesson.readTime} read</span>
              </div>
              <h3 className="text-xl sm:text-2xl font-bold text-stone-100">{selectedLesson.title}</h3>
              <p className="text-xs sm:text-sm text-stone-400 mt-1">{selectedLesson.summary}</p>
            </div>

            {/* Content Sections */}
            <div className="space-y-6 text-xs sm:text-sm text-stone-300 leading-relaxed">
              {selectedLesson.content.map((sec, idx) => (
                <div key={idx} className="space-y-3">
                  <h4 className="text-base font-bold text-stone-100">{sec.heading}</h4>
                  <p className="text-stone-300 leading-relaxed">{sec.body}</p>

                  {/* Key Takeaways */}
                  {sec.keyTakeaways && sec.keyTakeaways.length > 0 && (
                    <div className="p-3.5 rounded-xl bg-stone-950/70 border border-stone-800/80 space-y-1.5">
                      <span className="text-xs font-bold text-amber-400 uppercase tracking-wider block">
                        Core Principles:
                      </span>
                      <ul className="list-disc list-inside space-y-1 text-xs text-stone-300">
                        {sec.keyTakeaways.map((point, pIdx) => (
                          <li key={pIdx}>{point}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Dual Perspectives */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                    {sec.investingTakeaway && (
                      <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-300 block mb-1">
                          Investing Lens
                        </span>
                        <p className="text-xs text-stone-300">{sec.investingTakeaway}</p>
                      </div>
                    )}
                    {sec.tradingTakeaway && (
                      <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300 block mb-1">
                          Trading Lens
                        </span>
                        <p className="text-xs text-stone-300">{sec.tradingTakeaway}</p>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Interactive Concept Quiz */}
            <div className="mt-8 pt-6 border-t border-stone-800">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-400 mb-3">
                <HelpCircle className="w-4 h-4" />
                <span>Comprehension Checkpoint Quiz</span>
              </div>

              <div className="p-4 rounded-xl bg-stone-950/80 border border-stone-800 space-y-3">
                <p className="text-sm font-semibold text-stone-100">
                  {selectedLesson.quiz.question}
                </p>

                <div className="space-y-2">
                  {selectedLesson.quiz.options.map((option, oIdx) => {
                    let btnStyle = 'bg-stone-900 border-stone-800 text-stone-300 hover:bg-stone-850';
                    if (hasSubmitted) {
                      if (oIdx === selectedLesson.quiz.correctIndex) {
                        btnStyle = 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300 font-semibold';
                      } else if (oIdx === selectedAnswer) {
                        btnStyle = 'bg-rose-500/20 border-rose-500/60 text-rose-300';
                      } else {
                        btnStyle = 'bg-stone-950/60 border-stone-850 text-stone-600';
                      }
                    } else if (selectedAnswer === oIdx) {
                      btnStyle = 'bg-amber-500/20 border-amber-500/50 text-amber-300 font-semibold';
                    }

                    return (
                      <button
                        key={oIdx}
                        onClick={() => handleSelectOption(oIdx)}
                        disabled={hasSubmitted}
                        className={`w-full text-left p-3 rounded-lg border text-xs transition-all flex items-center justify-between ${btnStyle}`}
                      >
                        <span>{option}</span>
                        {hasSubmitted && oIdx === selectedLesson.quiz.correctIndex && (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 ml-2" />
                        )}
                        {hasSubmitted && oIdx === selectedAnswer && oIdx !== selectedLesson.quiz.correctIndex && (
                          <XCircle className="w-4 h-4 text-rose-400 shrink-0 ml-2" />
                        )}
                      </button>
                    );
                  })}
                </div>

                {!hasSubmitted ? (
                  <div className="pt-2 flex justify-end">
                    <button
                      onClick={handleSubmitQuiz}
                      disabled={selectedAnswer === null}
                      className="px-4 py-1.5 rounded-lg text-xs font-bold bg-amber-500 hover:bg-amber-400 text-stone-950 disabled:opacity-40 transition-colors"
                    >
                      Verify Answer
                    </button>
                  </div>
                ) : (
                  <div className={`p-3 rounded-lg text-xs mt-3 border ${
                    isCorrect 
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' 
                      : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                  }`}>
                    <span className="font-bold block mb-1">
                      {isCorrect ? 'Correct!' : 'Incorrect.'}
                    </span>
                    <p>{selectedLesson.quiz.explanation}</p>
                  </div>
                )}
              </div>
            </div>

          </div>
        </div>

      </div>
    </div>
  );
};
