import { Request, Response } from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import Course from "../models/courseModel";
import Transaction from "../models/transactionModel";
import UserCourseProgress from "../models/userCourseProgressModel";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

dotenv.config();

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is required but was not found in env variables");
}

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.AWS_REGION) {
  throw new Error("AWS credentials or region are missing in env variables");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-06-30.basil",
});

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export const createCourse = async (req: Request, res: Response): Promise<void> => {
  try {
    const { title, teacherName, price, sections } = req.body;
    const course = await Course.create({
      id: req.body.id || new Date().toISOString(),
      title,
      teacherName,
      price,
      sections,
    });

    const product = await stripe.products.create({
      name: title,
      description: `Course: ${title}`,
    });
    const stripePrice = await stripe.prices.create({
      product: product.id,
      unit_amount: price * 100,
      currency: "usd",
    });

    res.status(201).json({ course, stripePrice });
  } catch (error) {
    res.status(500).json({ message: "Error creating course", error });
  }
};

export const deleteCourse = async (req: Request, res: Response): Promise<void> => {
  try {
    await Course.delete(req.params.courseId);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ message: "Error deleting course", error });
  }
};

export const getCourse = async (req: Request, res: Response): Promise<void> => {
  try {
    const course = await Course.get(req.params.courseId);
    if (!course) {
      res.status(404).json({ message: "Course not found" });
      return;
    }
    res.status(200).json(course);
  } catch (error) {
    res.status(500).json({ message: "Error retrieving course", error });
  }
};

export const listCourses = async (req: Request, res: Response): Promise<void> => {
  try {
    const courses = await Course.scan().exec();
    res.status(200).json(courses);
  } catch (error) {
    res.status(500).json({ message: "Error listing courses", error });
  }
};

export const updateCourse = async (req: Request, res: Response): Promise<void> => {
  try {
    const { courseId } = req.params;
    const updates = req.body;
    if (req.file) {
      const command = new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: `courses/${courseId}/${req.file.originalname}`,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      });
      await s3Client.send(command);
      updates.imageUrl = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/courses/${courseId}/${req.file.originalname}`;
    }
    const course = await Course.update({ id: courseId }, updates);
    res.status(200).json(course);
  } catch (error) {
    res.status(500).json({ message: "Error updating course", error });
  }
};

export const getUploadVideoUrl = async (req: Request, res: Response): Promise<void> => {
  try {
    const { courseId, sectionId, chapterId } = req.params;
    const key = `courses/${courseId}/sections/${sectionId}/chapters/${chapterId}/video.mp4`;
    const command = new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key,
      ContentType: "video/mp4",
    });
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    res.status(200).json({ url: uploadUrl });
  } catch (error) {
    res.status(500).json({ message: "Error generating upload URL", error });
  }
};

export const listTransactions = async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.query as { userId?: string };

  try {
    const transactions = userId
      ? await Transaction.query("userId").eq(userId).exec()
      : await Transaction.scan().exec();

    res.json({
      message: "Transactions retrieved successfully",
      data: transactions,
    });
  } catch (error) {
    res.status(500).json({ message: "Error retrieving transactions", error });
  }
};

export const createStripePaymentIntent = async (req: Request, res: Response): Promise<void> => {
  let { amount } = req.body;

  if (!amount || amount <= 0) {
    amount = 50;
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "usd",
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
    });

    res.json({
      message: "",
      data: {
        clientSecret: paymentIntent.client_secret,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Error creating stripe payment intent", error });
  }
};

export const createTransaction = async (req: Request, res: Response): Promise<void> => {
  const { userId, courseId, transactionId, amount, paymentProvider } = req.body;

  try {
    const course = await Course.get(courseId);
    if (!course) {
      res.status(404).json({ message: "Course not found" });
      return;
    }

    const newTransaction = new Transaction({
      dateTime: new Date().toISOString(),
      userId,
      courseId,
      transactionId,
      amount,
      paymentProvider,
    });
    await newTransaction.save();

    const initialProgress = new UserCourseProgress({
      userId,
      courseId,
      enrollmentDate: new Date().toISOString(),
      overallProgress: 0,
      sections: course.sections.map((section: any) => ({
        sectionId: section.sectionId,
        chapters: section.chapters.map((chapter: any) => ({
          chapterId: chapter.chapterId,
          completed: false,
        })),
      })),
      lastAccessedTimestamp: new Date().toISOString(),
    });
    await initialProgress.save();

    await Course.update(
      { id: courseId },
      {
        $ADD: {
          enrollments: [{ userId }],
        },
      }
    );

    res.json({
      message: "Purchased Course successfully",
      data: {
        transaction: newTransaction,
        courseProgress: initialProgress,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Error creating transaction and enrollment", error });
  }
};