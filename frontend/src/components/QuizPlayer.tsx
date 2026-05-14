import { useState } from "react";
import {
  SpaceBetween,
  RadioGroup,
  Button,
  Box,
  Alert,
  ProgressBar,
  Container,
  Header,
  Badge,
} from "@cloudscape-design/components";

interface Question {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

interface Props {
  questions: Question[];
}

type Answer = number | null;

export default function QuizPlayer({ questions }: Props) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>(new Array(questions.length).fill(null));
  const [submitted, setSubmitted] = useState(false);
  const [showExplanation, setShowExplanation] = useState(false);

  const question = questions[currentIndex];
  const selectedAnswer = answers[currentIndex];
  const isCorrect = selectedAnswer === question.correctIndex;
  const score = answers.filter((a, i) => a === questions[i].correctIndex).length;

  const select = (val: string) => {
    if (submitted) return;
    setAnswers((prev) => {
      const next = [...prev];
      next[currentIndex] = parseInt(val);
      return next;
    });
  };

  const submit = () => {
    setSubmitted(true);
    setShowExplanation(true);
  };

  const next = () => {
    setSubmitted(false);
    setShowExplanation(false);
    setCurrentIndex((i) => Math.min(i + 1, questions.length - 1));
  };

  const allDone = currentIndex === questions.length - 1 && submitted;

  return (
    <Container header={<Header variant="h2">Quiz</Header>}>
      <SpaceBetween size="m">
        <ProgressBar
          value={Math.round(((currentIndex + (submitted ? 1 : 0)) / questions.length) * 100)}
          label={`Question ${currentIndex + 1} of ${questions.length}`}
        />

        {allDone && (
          <Alert type={score >= questions.length * 0.8 ? "success" : "info"}>
            Final score: {score} / {questions.length} ({Math.round((score / questions.length) * 100)}%)
          </Alert>
        )}

        <Box variant="h3">{question.question}</Box>

        <RadioGroup
          value={selectedAnswer?.toString() ?? ""}
          onChange={(e) => select(e.detail.value)}
          items={question.options.map((opt, i) => ({
            value: i.toString(),
            label: opt,
            disabled: submitted,
          }))}
        />

        {showExplanation && (
          <Alert type={isCorrect ? "success" : "error"}>
            {isCorrect ? "Correct! " : `Incorrect. The answer is: ${question.options[question.correctIndex]}. `}
            {question.explanation}
          </Alert>
        )}

        <SpaceBetween direction="horizontal" size="xs">
          {!submitted && (
            <Button
              variant="primary"
              onClick={submit}
              disabled={selectedAnswer === null}
            >
              Submit answer
            </Button>
          )}
          {submitted && !allDone && (
            <Button variant="primary" onClick={next}>
              Next question
            </Button>
          )}
          <Box color="text-body-secondary">
            Score: {score}/{answers.filter((a) => a !== null).length}
          </Box>
        </SpaceBetween>
      </SpaceBetween>
    </Container>
  );
}
