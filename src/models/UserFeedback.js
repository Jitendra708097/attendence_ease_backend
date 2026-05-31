module.exports = (sequelize, DataTypes) => {
  const UserFeedback = sequelize.define(
    'UserFeedback',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      emp_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      rating: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: {
          min: 1,
          max: 5,
        },
      },
      feedback_type: {
        type: DataTypes.ENUM('bug', 'suggestion', 'confusing', 'other'),
        allowNull: false,
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      employee_name: DataTypes.STRING,
      employee_email: DataTypes.STRING,
      employee_phone: DataTypes.STRING,
      employee_code: DataTypes.STRING,
      app_context: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
    },
    {
      tableName: 'user_feedback',
      paranoid: true,
      underscored: true,
    }
  );

  UserFeedback.associate = (models) => {
    UserFeedback.belongsTo(models.Organisation, { foreignKey: 'org_id', as: 'organisation' });
    UserFeedback.belongsTo(models.Employee, { foreignKey: 'emp_id', as: 'employee' });
  };

  return UserFeedback;
};
